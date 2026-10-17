/**
 * lib/ids-shared (the GID ⇄ number boundary of the compact fact tables) and lib/partitions-shared
 * (month partitions: names, retention, which months exist / go).
 */
import { describe, expect, it } from "vitest";
import {
  addMonths,
  amountToCents,
  centsToAmount,
  dayAsDate,
  dayOfMonth,
  daysInMonth,
  intString,
  monthOf,
  monthSegments,
  monthsBetween,
  toNumber,
  variantGid,
  variantNum,
} from "../app/lib/ids-shared";
import {
  STOCK_KEEP_DAYS,
  createPartitionSql,
  droppableMonths,
  isKept,
  keepFrom,
  partitionMonth,
  partitionName,
  wantedMonths,
} from "../app/lib/partitions-shared";
import { PACE_LOOKBACK_DAYS } from "../app/lib/engine/rate-shared";

describe("ids-shared", () => {
  it("variant GIDs ⇄ their numbers, exactly (no float on the way)", () => {
    expect(variantNum("gid://shopify/ProductVariant/45123456789012")).toBe("45123456789012");
    expect(variantNum("gid://shopify/ProductVariant/9223372036854775807")).toBe("9223372036854775807");
    expect(variantGid(45123456789012n)).toBe("gid://shopify/ProductVariant/45123456789012");
    expect(variantGid("9007199254740993")).toBe("gid://shopify/ProductVariant/9007199254740993");
    expect(variantGid(7)).toBe("gid://shopify/ProductVariant/7");
    for (const id of [45123456789012, 1, 9007199254740993n]) expect(variantNum(variantGid(id))).toBe(String(id));
  });

  it("anything that is not a numeric ProductVariant GID has no number", () => {
    expect(variantNum("v1")).toBeNull();
    expect(variantNum("gid://shopify/Product/1")).toBeNull();
    expect(variantNum("gid://shopify/ProductVariant/")).toBeNull();
    expect(variantNum("gid://shopify/ProductVariant/12a")).toBeNull();
    expect(variantNum("gid://shopify/ProductVariant/9223372036854775808")).toBeNull(); // past int8
  });

  it("database numbers of every driver shape", () => {
    expect(intString(12n)).toBe("12");
    expect(intString("0012")).toBe("12");
    expect(intString({ toString: () => "42" })).toBe("42");
    expect(() => intString(1.5)).toThrow();
    expect(toNumber(null)).toBeNull();
    expect(toNumber(3n)).toBe(3);
    expect(toNumber("4.25")).toBe(4.25);
    expect(toNumber({ toNumber: () => 9 })).toBe(9);
  });

  it("cents ⇄ amounts give exactly what parsing the decimal gives", () => {
    expect(centsToAmount("1234")).toBe(12.34);
    expect(centsToAmount(5n)).toBe(0.05);
    expect(centsToAmount("-199")).toBe(-1.99);
    expect(centsToAmount("0")).toBe(0);
    expect(amountToCents(19.99)).toBe("1999");
    expect(amountToCents(0.1 + 0.2)).toBe("30");
    for (const a of [0.01, 1.1, 2.675, 1234567.89, -3.3]) expect(centsToAmount(amountToCents(a))).toBe(Math.round(a * 100) / 100);
  });

  it("days and months", () => {
    expect(dayAsDate("2026-10-17").toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(dayAsDate(new Date("2026-10-17T00:00:00Z")).toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(monthOf("2026-10-17")).toBe("2026-10-01");
    expect(dayOfMonth("2026-10-07")).toBe(7);
    expect(addMonths("2026-11-01", 2)).toBe("2027-01-01");
    expect(addMonths("2026-01-01", -13)).toBe("2024-12-01");
    expect(daysInMonth("2024-02-01")).toBe(29);
    expect(daysInMonth("2026-02-01")).toBe(28);
    expect(monthsBetween("2026-11-15", "2027-01-02")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
  });

  it("a day range cut at month ends (one stock write per month)", () => {
    expect(monthSegments("2026-09-28", "2026-10-02")).toEqual([
      { month: "2026-09-01", since: "2026-09-28", until: "2026-09-30", a: 28, b: 30 },
      { month: "2026-10-01", since: "2026-10-01", until: "2026-10-02", a: 1, b: 2 },
    ]);
    expect(monthSegments("2026-10-05", "2026-10-05")).toEqual([{ month: "2026-10-01", since: "2026-10-05", until: "2026-10-05", a: 5, b: 5 }]);
    expect(monthSegments("2026-10-06", "2026-10-05")).toEqual([]);
  });
});

describe("partitions-shared", () => {
  it("names partitions by table and month, and reads them back", () => {
    expect(partitionName("SalesFact", "2026-10-01")).toBe("SalesFact_p202610");
    expect(partitionMonth("StockMonth", "StockMonth_p202601")).toBe("2026-01-01");
    expect(partitionMonth("StockMonth", "SalesFact_p202601")).toBeNull();
    expect(partitionMonth("SalesFact", "SalesFact_p202613")).toBeNull();
    expect(createPartitionSql("SalesFact", "2026-12-01")).toContain(`FOR VALUES FROM ('2026-12-01') TO ('2027-01-01')`);
    expect(createPartitionSql("StockMonth", "2026-12-01")).toMatch(/fillfactor = 85/);
  });

  it("keeps sales 25 months and stock the longest stock read plus a margin", () => {
    expect(STOCK_KEEP_DAYS).toBeGreaterThanOrEqual(PACE_LOOKBACK_DAYS);
    expect(keepFrom("SalesFact", "2026-10-17")).toBe("2024-09-17");
    expect(keepFrom("SessionsFact", "2026-10-17")).toBe("2024-09-17");
    expect(keepFrom("StockMonth", "2026-10-17")).toBe("2025-08-13");
    expect(isKept("StockMonth", "2025-08-01", "2026-10-17")).toBe(true); // its month is still kept
    expect(isKept("StockMonth", "2025-07-31", "2026-10-17")).toBe(false);
  });

  it("wants every month from the cutoff's through two ahead; drops only months wholly past the cutoff", () => {
    const want = wantedMonths("StockMonth", "2026-10-17");
    expect(want[0]).toBe("2025-08-01");
    expect(want[want.length - 1]).toBe("2026-12-01");
    expect(want).toHaveLength(17);
    expect(wantedMonths("SalesFact", "2026-10-17")[0]).toBe("2024-09-01");
    expect(droppableMonths("StockMonth", ["2025-06-01", "2025-07-01", "2025-08-01", "2025-09-01"], "2026-10-17")).toEqual(["2025-06-01", "2025-07-01"]);
    // 2024-09 holds the cutoff day 2024-09-17: kept until October.
    expect(droppableMonths("SalesFact", ["2024-08-01", "2024-09-01"], "2026-10-17")).toEqual(["2024-08-01"]);
    expect(droppableMonths("SalesFact", ["2024-08-01", "2024-09-01"], "2026-11-01")).toEqual(["2024-08-01", "2024-09-01"]);
  });
});
