import { describe, expect, it } from "vitest";
import { COVER_DAYS_MAX, COVER_DAYS_MIN, planVariant, readCoverDays, withCoverDays, type ForwardVariantInput } from "../../app/lib/engine/forward-plan-shared";
import { demand } from "../../app/lib/engine/order-shared";
import { whyLines } from "../../app/lib/order-plan-shared";
import { parseCoverParams, withCoverParam } from "../../app/lib/reorder-shared";
import { builderLink } from "../../app/lib/supplier-order-shared";
import { TODAY } from "./fixtures";

// Kanwar 2026-10-18: "order for 150 or 180 days on this purchase order" without changing Settings.

/** Steady seller: 2/day, safety 10, lead 14, cycle 14, 40 on hand (an order today). */
function low(over: Partial<ForwardVariantInput> = {}): ForwardVariantInput {
  const base = { today: TODAY, status: "healthy", rate: 2, seasonal: 1, trend: 1, plan: 1, curve: null, safety: 10, leadTimeDays: 14, cycleDays: 14, onHand: 40, incoming: 0, arrivals: [], pack: null, moq: null, days: 91, ...over };
  const need = demand(base.rate as number, { seasonal: 1, trend: 1, plan: 1 }, base.leadTimeDays + base.cycleDays) + (base.safety as number) - base.onHand;
  return { ...base, need };
}

const firstQty = (i: ForwardVariantInput) => planVariant(i).orders[0]!;

describe("Order enough for N days", () => {
  it("covers lead time + N days, safety scaled by √ of the horizon", () => {
    const base = low();
    const c180 = withCoverDays(base, 180);
    expect(c180.cycleDays).toBe(180);
    expect(c180.coverChosen).toBe(180);
    expect(c180.safety).toBeCloseTo(10 * Math.sqrt((14 + 180) / (14 + 14)), 9);
    const o = firstQty(c180);
    expect(o.day).toBe(0);
    expect(o.why!.days).toBe(194);
    expect(o.why!.chosenDays).toBe(180);
    // 2/day over 194 days + safety − 40 on hand (40 lasts 20 days > the 14-day lead: nothing missed).
    expect(o.why!.missed ?? 0).toBe(0);
    expect(o.qty).toBe(Math.ceil(2 * 194 + 10 * Math.sqrt(194 / 28) - 40 - 1e-9));
  });

  it("more days never orders less (30 … 365)", () => {
    let last = 0;
    for (const n of [30, 60, 90, 120, 150, 180, 270, 365]) {
      const q = firstQty(withCoverDays(low(), n)).qty;
      expect(q).toBeGreaterThan(last);
      last = q;
    }
  });

  it("null keeps the plan's own cycle; the Why says the days were chosen", () => {
    expect(withCoverDays(low(), null)).toEqual(low());
    expect(firstQty(low()).why!.chosenDays ?? null).toBeNull();
    const why = firstQty(withCoverDays(low(), 90)).why!;
    const lines = whyLines(why, (s) => s, "en");
    expect(lines).toContain("You chose to order enough for 90 days after it arrives.");
  });

  it("reads only whole days in range", () => {
    expect(readCoverDays("180")).toBe(180);
    expect(readCoverDays(COVER_DAYS_MIN)).toBe(COVER_DAYS_MIN);
    expect(readCoverDays(COVER_DAYS_MAX + 1)).toBeNull();
    expect(readCoverDays("6")).toBeNull();
    expect(readCoverDays("90.5")).toBeNull();
    expect(readCoverDays("")).toBeNull();
    expect(readCoverDays(null)).toBeNull();
  });

  it("one choice per supplier in the URL, and into the builder link", () => {
    const p = new URLSearchParams("variants=x");
    const a = withCoverParam(p, "supplier:abc", 180);
    const b = withCoverParam(a, "vendor:acme co", 90);
    const c = withCoverParam(b, "supplier:abc", 120);
    expect([...parseCoverParams(c.getAll("cover"), readCoverDays)]).toEqual([
      ["vendor:acme co", 90],
      ["supplier:abc", 120],
    ]);
    expect(c.get("variants")).toBe("x");
    expect(parseCoverParams(withCoverParam(c, "supplier:abc", null).getAll("cover"), readCoverDays).has("supplier:abc")).toBe(false);
    expect(parseCoverParams(["bad", "supplier:x~5", "supplier:y~abc", "supplier:z~60"], readCoverDays)).toEqual(new Map([["supplier:z", 60]]));
    expect(builderLink("supplier:abc", null, 150)).toBe("/app/reorder/build?supplier=supplier:abc&days=150");
    expect(builderLink("supplier:abc")).toBe("/app/reorder/build?supplier=supplier:abc");
  });
});
