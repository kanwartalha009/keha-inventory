/**
 * Weekly sales re-check, pure part (lib/sync/weekly-recheck-shared): the 35-day window (never
 * today, never past the sales sync), the days that differ (the reconcile rule), runs of days,
 * what the rewrite changed, the weekly slot per shop, and the 2% merchant notice.
 */
import { describe, expect, it } from "vitest";
import {
  RECHECK_DAYS,
  dayRuns,
  differingDays,
  hourOfWeek,
  isRecheckDue,
  readWeeklyRecheck,
  recheckNoticeText,
  recheckRange,
  recheckSlot,
  recheckSummary,
  showRecheckNotice,
  type WeeklyRecheck,
} from "../app/lib/sync/weekly-recheck-shared";
import { addDays } from "../app/lib/sync/shopifyql-shared";

const t = (s: string) => s;
const count = (n: number) => String(n);
const window35 = (until: string) => ({ since: addDays(until, -34), until });
/** 35 days of 10 units a day ending 2026-10-17, with overrides. */
function units(over: Record<string, number> = {}, until = "2026-10-17"): Map<string, number> {
  const m = new Map<string, number>();
  for (let d = addDays(until, -34); d <= until; d = addDays(d, 1)) m.set(d, 10);
  for (const [d, u] of Object.entries(over)) m.set(d, u);
  return m;
}
const run = (over: Partial<WeeklyRecheck> = {}): WeeklyRecheck => ({
  at: "2026-10-18T05:00:00.000Z",
  outcome: "done",
  since: "2026-09-13",
  until: "2026-10-17",
  differing: 1,
  corrected: 1,
  unitsBefore: 350,
  unitsAfter: 340,
  changed: 10,
  share: 10 / 350,
  ...over,
});

describe("the window", () => {
  it("35 days ending yesterday — never today", () => {
    expect(RECHECK_DAYS).toBe(35);
    expect(recheckRange("2026-10-17", "2026-10-17")).toEqual({ since: "2026-09-13", until: "2026-10-17" });
    expect(recheckRange("2026-10-17", "2026-10-18")!.until).toBe("2026-10-17"); // a stored day past yesterday is ignored
  });
  it("ends at the last day the sales sync stored when that is earlier; null before any sales sync", () => {
    expect(recheckRange("2026-10-17", "2026-10-10")).toEqual({ since: "2026-09-06", until: "2026-10-10" });
    expect(recheckRange("2026-10-17", null)).toBeNull();
  });
});

describe("the days that differ", () => {
  const range = window35("2026-10-17");
  it("a refunded order 20 days ago: only that day", () => {
    const refundDay = addDays("2026-10-17", -20);
    expect(differingDays(units(), units({ [refundDay]: 8 }), range)).toEqual([refundDay]);
  });
  it("the reconcile rule: under 0.5 apart is the same, a day missing on one side counts as 0, days outside the window are ignored", () => {
    expect(differingDays(units({ "2026-10-01": 10.4 }), units(), range)).toEqual([]);
    const stored = units();
    stored.delete("2026-10-02");
    expect(differingDays(stored, units(), range)).toEqual(["2026-10-02"]);
    expect(differingDays(units(), new Map([...units(), ["2026-08-01", 99]]), range)).toEqual([]);
  });
  it("runs of days: one re-read per contiguous run", () => {
    expect(dayRuns(["2026-10-05", "2026-10-03", "2026-10-04", "2026-09-28", "2026-10-05"])).toEqual([
      { since: "2026-09-28", until: "2026-09-28" },
      { since: "2026-10-03", until: "2026-10-05" },
    ]);
    expect(dayRuns(["2026-02-28", "2026-03-01"])).toEqual([{ since: "2026-02-28", until: "2026-03-01" }]);
    expect(dayRuns([])).toEqual([]);
  });
});

describe("what the rewrite changed", () => {
  const range = window35("2026-10-17");
  it("counts the days whose stored units moved and the share of the window", () => {
    const refundDay = addDays("2026-10-17", -20);
    const s = recheckSummary(units(), units({ [refundDay]: 2 }), range);
    expect(s).toEqual({ corrected: 1, unitsBefore: 350, unitsAfter: 342, changed: 8, share: 8 / 350 });
  });
  it("a re-read that changes nothing corrects nothing (units without a variant)", () => {
    expect(recheckSummary(units(), units(), range)).toMatchObject({ corrected: 0, changed: 0, share: 0 });
  });
  it("offsetting edits still count (Σ |after − before|)", () => {
    expect(recheckSummary(units(), units({ "2026-10-01": 15, "2026-10-02": 5 }), range)).toMatchObject({ corrected: 2, changed: 10, unitsAfter: 350 });
  });
  it("no units before and some now: share 1", () => {
    expect(recheckSummary(new Map(), new Map([["2026-10-01", 3]]), range).share).toBe(1);
  });
});

describe("the weekly slot", () => {
  const shop = "acme.myshopify.com";
  const slot = recheckSlot(shop);
  // A Sunday 00:00 UTC, then the shop's slot hour that week.
  const sunday = Date.parse("2026-10-18T00:00:00Z");
  const atSlot = new Date(sunday + slot * 3600_000 + 5 * 60_000);
  it("each shop gets one hour of the week, spread across shops", () => {
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(slot).toBeLessThan(168);
    expect(recheckSlot(shop)).toBe(slot); // stable
    const slots = new Set(Array.from({ length: 500 }, (_, i) => recheckSlot(`store-${i}.myshopify.com`)));
    expect(slots.size).toBeGreaterThan(120);
    expect(hourOfWeek(atSlot)).toBe(slot);
  });
  it("first time: on its slot hour only", () => {
    expect(isRecheckDue(shop, null, atSlot)).toBe(true);
    expect(isRecheckDue(shop, null, new Date(atSlot.getTime() + 3600_000))).toBe(false);
  });
  it("then weekly: not again within 6 days, again on the slot a week later", () => {
    const last = run({ at: atSlot.toISOString() });
    expect(isRecheckDue(shop, last, new Date(atSlot.getTime() + 10 * 60_000))).toBe(false);
    expect(isRecheckDue(shop, last, new Date(atSlot.getTime() + 7 * 24 * 3600_000))).toBe(true);
    expect(isRecheckDue(shop, last, new Date(atSlot.getTime() + 7 * 24 * 3600_000 + 3600_000))).toBe(false);
  });
  it("missed its slot (8+ days): on the next tick", () => {
    const last = run({ at: atSlot.toISOString() });
    expect(isRecheckDue(shop, last, new Date(atSlot.getTime() + 8 * 24 * 3600_000 + 2 * 3600_000))).toBe(true);
  });
  it("reads the stored result, ignores junk", () => {
    expect(readWeeklyRecheck({ weeklyRecheck: run() })?.corrected).toBe(1);
    expect(readWeeklyRecheck({ weeklyRecheck: { at: "nope" } })).toBeNull();
    expect(readWeeklyRecheck({})).toBeNull();
    expect(readWeeklyRecheck(null)).toBeNull();
  });
});

describe("the merchant notice", () => {
  const now = new Date("2026-10-19T10:00:00Z");
  it("nothing at 2% or less, or when nothing was corrected, or after an error", () => {
    expect(showRecheckNotice(run({ share: 0.02, changed: 7 }), now)).toBe(false);
    expect(showRecheckNotice(run(), now)).toBe(true); // 10 of 350 = 2.9%
    expect(showRecheckNotice(run({ corrected: 0, share: 0.5 }), now)).toBe(false);
    expect(showRecheckNotice(run({ outcome: "error" }), now)).toBe(false);
    expect(showRecheckNotice(null, now)).toBe(false);
  });
  it("for 8 days after the re-check", () => {
    expect(showRecheckNotice(run(), new Date("2026-10-26T04:00:00Z"))).toBe(true);
    expect(showRecheckNotice(run(), new Date("2026-10-26T06:00:00Z"))).toBe(false);
  });
  it("a quiet line", () => {
    expect(recheckNoticeText(1, t, count)).toBe("Shopify updated 1 day of past sales (refunds or order edits). Your numbers include it.");
    expect(recheckNoticeText(3, t, count)).toBe("Shopify updated 3 days of past sales (refunds or order edits). Your numbers include them.");
  });
});
