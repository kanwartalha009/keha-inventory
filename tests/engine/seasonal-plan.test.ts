/**
 * The forward plan around seasons and minimums (sim check 2026-10-17, A1 / A2): an item whose lead
 * time + cycle falls in its off season is not overdue and orders for the season start; a late
 * order is never dated more than one lead time back; safety follows the season; a tiny need of a
 * slow style is never raised to a full minimum per style. Pinned dates only.
 */
import { describe, expect, it } from "vitest";
import {
  BELOW_MIN_SHARE,
  OFF_SEASON_SHARE,
  dueNote,
  eventsOf,
  planStore,
  planVariant,
  type ForwardVariantInput,
  type PlanVariantSpec,
} from "../../app/lib/engine/forward-plan-shared";
import { addDays, daysBetween } from "../../app/lib/engine/dates-shared";
import { dueText } from "../../app/lib/order-plan-shared";
import { translate } from "../../app/lib/i18n";
import { TODAY } from "./fixtures";

/** Swimwear in mid-October: 20 weeks at a tenth of its spring/summer level, then 20 weeks of season. */
const SWIM = [...new Array(20).fill(0.3), ...new Array(20).fill(3)];

function item(over: Partial<ForwardVariantInput> = {}): ForwardVariantInput {
  return {
    today: TODAY,
    status: "healthy",
    rate: 1,
    seasonal: 0.3,
    trend: 1,
    plan: 1,
    curve: SWIM,
    safety: 3,
    leadTimeDays: 60,
    cycleDays: 45,
    onHand: 4,
    incoming: 0,
    arrivals: [],
    need: 10,
    pack: null,
    moq: null,
    days: 200,
    ...over,
  };
}

describe("off season (A1)", () => {
  it("swimwear in October with little stock: not overdue — the next order is the season's, one lead time before it starts", () => {
    const p = planVariant(item());
    expect(p.overdue).toBe(false);
    expect(p.nextSeason).toBe(true);
    // The season starts in week 20 (day 140): ordered so it lands around then, never in December.
    const first = p.orders[0]!;
    expect(first.nextSeason).toBe(true);
    expect(daysBetween(TODAY, first.arrives)).toBeGreaterThan(100);
    expect(daysBetween(TODAY, first.arrives)).toBeLessThanOrEqual(140);
    expect(p.deadline).toBe(first.orderBy);
    expect(p.orders.slice(1).every((o) => !o.nextSeason)).toBe(true);
    // Sold out, too: still not overdue in its off season.
    expect(planVariant(item({ onHand: 0, outSince: addDays(TODAY, -160) }))).toMatchObject({ overdue: false, nextSeason: true });
  });

  it("the season's order carries the season's safety stock (scaled by its window's demand), not October's", () => {
    const p = planVariant(item());
    expect(p.orders[0]!.why!.safety).toBeGreaterThan(3 * 2);
  });

  it("a product with no real season is never off season", () => {
    const flat = planVariant(item({ curve: null, seasonal: 1, onHand: 4 }));
    expect(flat.nextSeason).toBeUndefined();
    expect(flat.overdue).toBe(true);
    // A mild season (best window < 4 × now) isn't one either.
    expect(1 / OFF_SEASON_SHARE).toBe(4);
    expect(planVariant(item({ curve: [...new Array(20).fill(1), ...new Array(20).fill(2)], seasonal: 1 })).nextSeason).toBeUndefined();
  });

  it("labels: Next season: order by {date}; Overdue · sold out since / runs out {date}; translated", () => {
    const p = planVariant(item());
    const e = eventsOf(p, { variantId: "v", productId: "p", supplierKey: "s", unitCost: 1 });
    expect(dueNote(e)).toEqual({ nextSeason: true });
    const t = (x: string) => x;
    expect(dueText(e[0]!.orderBy, TODAY, t, "en", false, dueNote(e))).toMatch(/^Next season: order by /);
    expect(dueText(null, TODAY, t, "en", true, { soldOutSince: "2026-05-05" })).toBe("Overdue · sold out since May 5");
    expect(dueText(null, TODAY, t, "en", true, { runsOut: "2026-10-20" })).toBe("Overdue · runs out Oct 20");
    expect(dueText(null, TODAY, (x) => translate("de", x), "de", true, { soldOutSince: "2026-05-05" })).toBe("Überfällig · ausverkauft seit 5. Mai");
  });
});

describe("overdue is never months back (A1)", () => {
  const steady = (over: Partial<ForwardVariantInput> = {}) => item({ curve: null, seasonal: 1, rate: 2, safety: 10, leadTimeDays: 14, cycleDays: 14, need: 30, ...over });

  it("still in stock: the last day an order would still have arrived with its safety stock, at most one lead time back", () => {
    expect(planVariant(steady({ onHand: 30 })).deadline).toBe(addDays(TODAY, -4));
    const late = planVariant(steady({ onHand: 4 }));
    expect(late).toMatchObject({ overdue: true, deadline: null, context: { runsOut: addDays(TODAY, 1) } });
  });

  it("sold out: the day it ran out when within one lead time, else no date with that day as context", () => {
    expect(planVariant(steady({ onHand: 0, outSince: addDays(TODAY, -10) })).deadline).toBe(addDays(TODAY, -10));
    expect(planVariant(steady({ onHand: 0, outSince: "2026-05-05" }))).toMatchObject({ overdue: true, deadline: null, context: { soldOutSince: "2026-05-05" } });
  });
});

describe("below the supplier's minimum per style (A2)", () => {
  const spec = (n: number, over: Partial<ForwardVariantInput>): PlanVariantSpec => ({
    variantId: `v${n}`,
    productId: "swim",
    supplierKey: "s",
    unitCost: 5,
    weight: over.rate ?? 0.1,
    input: item({ curve: null, seasonal: 1, rate: 0.1, safety: 1, leadTimeDays: 14, cycleDays: 14, onHand: 1, need: 3, days: 14, ...over }),
  });
  const rules = { s: { styleMin: 240, minTotal: null, minValue: null } };

  it("a slow style needing a few units is held back, never raised to 240", () => {
    const plan = planStore([spec(1, {}), spec(2, {})], rules, TODAY);
    expect(plan.events).toEqual([]);
    expect(plan.belowMinimum).toHaveLength(1);
    expect(plan.belowMinimum![0]).toMatchObject({ supplierKey: "s", productId: "swim", variantIds: ["v1", "v2"], styleMin: 240, orderBy: TODAY });
    expect(plan.belowMinimum![0]!.units).toBeLessThan(BELOW_MIN_SHARE * 240);
  });

  it("a fast style (a minimum sells within lead time + cycle) is still topped up to the minimum", () => {
    const plan = planStore([spec(1, { rate: 20, onHand: 1, safety: 5 }), spec(2, { rate: 20, onHand: 300 })], rules, TODAY);
    expect(plan.belowMinimum).toEqual([]);
    const units = plan.events.filter((e) => e.productId === "swim" && e.orderBy === TODAY).reduce((a, e) => a + e.qty, 0);
    expect(units).toBeGreaterThanOrEqual(240);
  });
});
