/**
 * Ordering maths (spec §7.4): ABC, safety stock, demand, days left, order-by, order qty.
 */
import { describe, expect, it } from "vitest";
import {
  abcRoles,
  daysLeft,
  demand,
  orderByDate,
  orderQuantity,
  resolveLeadTime,
  safetyDays,
  safetyStock,
  zForRole,
} from "../../app/lib/engine/order-shared";
import { TODAY } from "./fixtures";

const ONE = { seasonal: 1, trend: 1, plan: 1 };

describe("abcRoles", () => {
  it("splits 80 / 15 / 5 on the cumulative share before each item", () => {
    const roles = abcRoles([
      { id: "c", revenue90: 5 },
      { id: "a", revenue90: 80 },
      { id: "b", revenue90: 15 },
    ]);
    expect(Object.fromEntries(roles)).toEqual({ a: "A", b: "B", c: "C" });
  });

  it("the item that crosses 80% is still A", () => {
    // a: before 0 → A; b: before 0.5 → A (crosses to 0.9); c: before 0.9 → B; d: before 0.97 → C.
    const roles = abcRoles([
      { id: "a", revenue90: 50 },
      { id: "b", revenue90: 40 },
      { id: "c", revenue90: 7 },
      { id: "d", revenue90: 3 },
    ]);
    expect(Object.fromEntries(roles)).toEqual({ a: "A", b: "A", c: "B", d: "C" });
  });

  it("breaks ties by id, independent of input order", () => {
    const items = [
      { id: "z", revenue90: 20 },
      { id: "x", revenue90: 60 },
      { id: "y", revenue90: 20 },
    ];
    const r1 = abcRoles(items);
    const r2 = abcRoles([...items].reverse());
    // x: 0 → A; y (tie, id first): 0.6 → A; z: 0.8 → B.
    expect(Object.fromEntries(r1)).toEqual({ x: "A", y: "A", z: "B" });
    expect(Object.fromEntries(r2)).toEqual(Object.fromEntries(r1));
  });

  it("zero, negative and non-finite revenue are C; all-zero shop is all C", () => {
    const roles = abcRoles([
      { id: "a", revenue90: 100 },
      { id: "b", revenue90: 0 },
      { id: "c", revenue90: -5 },
      { id: "d", revenue90: Number.NaN },
    ]);
    expect(Object.fromEntries(roles)).toEqual({ a: "A", b: "C", c: "C", d: "C" });
    const zero = abcRoles([
      { id: "a", revenue90: 0 },
      { id: "b", revenue90: 0 },
    ]);
    expect([...zero.values()]).toEqual(["C", "C"]);
  });

  it("throws on duplicate ids", () => {
    expect(() =>
      abcRoles([
        { id: "a", revenue90: 1 },
        { id: "a", revenue90: 2 },
      ]),
    ).toThrow(/duplicate/);
  });

  it("z by role is 1.65 / 1.28 / 1.04", () => {
    expect([zForRole("A"), zForRole("B"), zForRole("C")]).toEqual([1.65, 1.28, 1.04]);
  });
});

describe("demand, safety, days left", () => {
  it("demand(H) = rate × seasonal × trend × plan × H", () => {
    expect(demand(2, { seasonal: 1.5, trend: 0.8, plan: 1.2 }, 10)).toBeCloseTo(28.8, 12);
  });
  it("safety = z × σ × √leadTime; safetyDays = safety ÷ rate (0 when rate is 0)", () => {
    expect(safetyStock(1.65, 2, 16)).toBeCloseTo(13.2, 12);
    expect(safetyDays(13.2, 2)).toBeCloseTo(6.6, 12);
    expect(safetyDays(13.2, 0)).toBe(0);
  });
  it("daysLeft: 0 when onHand ≤ 0, Infinity when rate 0, else onHand ÷ rate", () => {
    expect(daysLeft(10, 2)).toBe(5);
    expect(daysLeft(10, 0)).toBe(Infinity);
    expect(daysLeft(0, 0)).toBe(0);
    expect(daysLeft(-3, 2)).toBe(0);
  });
  it("lead time: supplier value else shop default", () => {
    expect(resolveLeadTime(30)).toEqual({ days: 30, source: "supplier" });
    expect(resolveLeadTime(0)).toEqual({ days: 0, source: "supplier" });
    expect(resolveLeadTime(null)).toEqual({ days: 14, source: "default" });
    expect(resolveLeadTime(Number.NaN)).toEqual({ days: 14, source: "default" });
  });
});

describe("orderByDate", () => {
  it("today + daysLeft − leadTime − safetyDays, floored", () => {
    // 30 − 14 − 2.5 = 13.5 → 13 days.
    expect(orderByDate(TODAY, 30, 14, 2.5)).toBe("2026-10-29");
    expect(orderByDate("2026-12-25", 20, 0, 0)).toBe("2027-01-14");
  });
  it("can be in the past (order is overdue)", () => {
    // 5 − 14 − 0.5 = −9.5 → floor −10.
    expect(orderByDate(TODAY, 5, 14, 0.5)).toBe("2026-10-06");
  });
  it("is null when daysLeft is Infinity", () => {
    expect(orderByDate(TODAY, Infinity, 14, 0)).toBeNull();
  });
});

describe("orderQuantity", () => {
  const base = { demand: 23.2, safety: 0, onHand: 0, incoming: 0 };
  it("ceils the shortfall", () => {
    expect(orderQuantity(base)).toBe(24);
  });
  it("rounds up to the case pack", () => {
    expect(orderQuantity({ ...base, caseQty: 12 })).toBe(24);
    expect(orderQuantity({ ...base, caseQty: 10 })).toBe(30);
    expect(orderQuantity({ ...base, caseQty: 1 })).toBe(24);
  });
  it("then raises to the minimum order, kept in whole cases", () => {
    expect(orderQuantity({ ...base, minOrder: 50 })).toBe(50);
    expect(orderQuantity({ ...base, caseQty: 12, minOrder: 50 })).toBe(60);
    expect(orderQuantity({ ...base, caseQty: 12, minOrder: 10 })).toBe(24);
  });
  it("subtracts on hand + incoming and adds safety", () => {
    expect(orderQuantity({ demand: 60, safety: 6.6, onHand: 40, incoming: 10 })).toBe(17);
  });
  it("is null when the shortfall is ≤ 0, even with a minimum order", () => {
    expect(orderQuantity({ ...base, onHand: 30 })).toBeNull();
    expect(orderQuantity({ demand: 20, safety: 0, onHand: 20, incoming: 0, minOrder: 100 })).toBeNull();
  });
  it("does not over-order on float noise", () => {
    const d = demand(0.1 * 3, ONE, 100); // 30.000000000000004
    expect(d).toBeGreaterThan(30);
    expect(orderQuantity({ demand: d, safety: 0, onHand: 0, incoming: 0 })).toBe(30);
  });
});
