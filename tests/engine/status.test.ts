/**
 * Status rules and their order (spec §7.5).
 */
import { describe, expect, it } from "vitest";
import { variantStatus, type StatusInput } from "../../app/lib/engine/status-shared";
import { resolveSettings } from "../../app/lib/engine/types-shared";

const healthy: StatusInput = {
  onHand: 50,
  inStockDays: 90,
  noSaleDays: 0,
  productAgeDays: 400,
  daysLeft: 50,
  leadTimeDays: 14,
  safetyDays: 3,
  trend: 1,
};
const deadish: Partial<StatusInput> = { noSaleDays: 120, productAgeDays: 400 };
const s = (o: Partial<StatusInput>) => variantStatus({ ...healthy, ...o });

describe("variantStatus", () => {
  it("healthy baseline", () => {
    expect(s({})).toBe("healthy");
  });

  it("out: onHand ≤ 0 wins over everything", () => {
    expect(s({ onHand: 0 })).toBe("out");
    expect(s({ onHand: -2 })).toBe("out");
    expect(s({ onHand: 0, ...deadish })).toBe("out");
    expect(s({ onHand: 0, inStockDays: 3 })).toBe("out");
  });

  it("not_enough_data below 14 in-stock days, before dead", () => {
    expect(s({ inStockDays: 13 })).toBe("not_enough_data");
    expect(s({ inStockDays: 14 })).toBe("healthy");
    expect(s({ inStockDays: 13, ...deadish })).toBe("not_enough_data");
  });

  it("dead: ≥ 90 days without a sale AND product ≥ 90 days old", () => {
    expect(s({ noSaleDays: 90, productAgeDays: 90 })).toBe("dead");
    expect(s({ noSaleDays: 89, productAgeDays: 400 })).toBe("healthy");
  });

  it("dead requires a known product age ≥ 90", () => {
    expect(s({ noSaleDays: 120, productAgeDays: 89 })).toBe("healthy");
    expect(s({ noSaleDays: 120, productAgeDays: null })).toBe("healthy");
    expect(s({ noSaleDays: null, productAgeDays: 400 })).toBe("healthy");
  });

  it("dead wins over running_low and too_much", () => {
    expect(s({ ...deadish, daysLeft: 1 })).toBe("dead");
    expect(s({ ...deadish, daysLeft: Infinity })).toBe("dead");
  });

  it("running_low: daysLeft < leadTime + safetyDays", () => {
    expect(s({ daysLeft: 16.99 })).toBe("running_low");
    expect(s({ daysLeft: 17 })).toBe("healthy");
  });

  it("too_much: daysLeft > 180 and trend not rising", () => {
    expect(s({ daysLeft: 181 })).toBe("too_much");
    expect(s({ daysLeft: Infinity })).toBe("too_much");
    expect(s({ daysLeft: 180 })).toBe("healthy");
    expect(s({ daysLeft: 181, trend: 0.7 })).toBe("too_much");
    expect(s({ daysLeft: 181, trend: 1.01 })).toBe("healthy");
  });

  it("uses shop overrides for thresholds", () => {
    const settings = resolveSettings({ tooMuchDays: 90, deadDays: 60 });
    expect(variantStatus({ ...healthy, daysLeft: 100 }, settings)).toBe("too_much");
    expect(variantStatus({ ...healthy, noSaleDays: 60, productAgeDays: 60 }, settings)).toBe("dead");
  });
});
