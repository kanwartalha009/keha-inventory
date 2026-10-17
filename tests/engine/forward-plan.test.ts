/**
 * Forward order plan (engine/forward-plan-shared): fixtures for the day-by-day projection, the
 * order-by date, and the invariant that ties it to the Order now screen.
 */
import { describe, expect, it } from "vitest";
import {
  byWeek,
  bySupplier,
  cashTotals,
  dueWithin,
  eventsOf,
  forwardInputFromMetric,
  planDays,
  planEnd,
  planSkip,
  planVariant,
  seasonalFactors,
  type ForwardVariantInput,
} from "../../app/lib/engine/forward-plan-shared";
import { addDays, daysBetween } from "../../app/lib/engine/dates-shared";
import { demand, lineQuantity, orderByDate, safetyStock } from "../../app/lib/engine/order-shared";
import { computeVariant } from "../../app/lib/engine/index-shared";
import { buildReorderGroups, type ReorderMetricIn, type ReorderVariantIn } from "../../app/lib/reorder-shared";
import { TODAY, buildSeries, variantInput } from "./fixtures";

/** Steady seller: 2/day, safety 10, lead 14, cycle 14, nothing on order. */
function steady(over: Partial<ForwardVariantInput> = {}): ForwardVariantInput {
  const base = {
    today: TODAY,
    status: "healthy",
    rate: 2,
    seasonal: 1,
    trend: 1,
    plan: 1,
    curve: null,
    safety: 10,
    leadTimeDays: 14,
    cycleDays: 14,
    onHand: 100,
    incoming: 0,
    arrivals: [],
    pack: null,
    moq: null,
    days: 91,
    ...over,
  };
  // orderNeed exactly as computeVariant stores it.
  const need =
    over.need !== undefined
      ? over.need
      : demand(base.rate!, { seasonal: base.seasonal, trend: base.trend, plan: base.plan }, base.leadTimeDays + base.cycleDays) +
        base.safety! -
        (base.onHand + base.incoming);
  return { ...base, need };
}

describe("planVariant — order-by date", () => {
  it("steady seller: the nightly formula, one order every cycle", () => {
    const p = planVariant(steady());
    // 100 − 2 × (s + 14) ≥ 10 ⇔ s ≤ 31.
    expect(p.deadline).toBe(addDays(TODAY, 31));
    expect(p.deadline).toBe(orderByDate(TODAY, 50, 14, 5));
    expect(p.needNow).toBe(0);
    expect(p.orders.map((o) => o.day)).toEqual([31, 45, 59, 73, 87]);
    expect(p.orders.every((o) => o.qty === 28)).toBe(true);
    expect(p.orders[0]).toMatchObject({ orderBy: addDays(TODAY, 31), arrives: addDays(TODAY, 45), overdue: false, deadline: addDays(TODAY, 31) });
  });

  it("matches orderByDate for any flat forecast with nothing on order", () => {
    for (const onHand of [0, 3, 17, 40, 100, 333])
      for (const rate of [0.4, 1, 2.5, 7])
        for (const [lead, safety] of [[0, 0], [7, 3.2], [14, 10], [45, 22.5]] as const) {
          const p = planVariant(steady({ onHand, rate, leadTimeDays: lead, safety, days: 0 }));
          const left = onHand <= 0 ? 0 : onHand / rate;
          expect(p.deadline, `${onHand}/${rate}/${lead}/${safety}`).toBe(orderByDate(TODAY, left, lead, safety / rate));
        }
  });

  it("an incoming purchase order pushes the date out", () => {
    const without = planVariant(steady({ onHand: 40 }));
    // (40 − 10) ÷ 2 − 14 = 1.
    expect(without.deadline).toBe(addDays(TODAY, 1));
    const withPo = planVariant(steady({ onHand: 40, incoming: 60, arrivals: [{ day: addDays(TODAY, 10), units: 60 }] }));
    // (100 − 10) ÷ 2 − 14 = 31.
    expect(withPo.deadline).toBe(addDays(TODAY, 31));
    expect(withPo.orders[0]!.day).toBe(31);
    // A PO that lands after the dip: ordered on time anyway (the dip before it is the deadline)…
    const late = planVariant(steady({ onHand: 40, incoming: 60, arrivals: [{ day: addDays(TODAY, 30), units: 60 }] }));
    expect(late.deadline).toBe(addDays(TODAY, 1));
    // …but no units are double-ordered: the PO counts in the position.
    expect(late.needNow).toBe(0);
  });

  it("an overdue order: dated in the past, ordered today", () => {
    const p = planVariant(steady({ onHand: 5 }));
    // ⌊(5 − 28 − 10) ÷ 2⌋ = −17, as the nightly formula.
    expect(p.deadline).toBe(addDays(TODAY, -17));
    expect(p.deadline).toBe(orderByDate(TODAY, 2.5, 14, 5));
    expect(p.orders[0]).toMatchObject({ day: 0, orderBy: TODAY, overdue: true, qty: 61, deadline: addDays(TODAY, -17) });
  });
});

describe("planVariant — quantities and seasonality", () => {
  it("rounds to the case pack, then the minimum order", () => {
    expect(planVariant(steady({ pack: 12 })).orders[0]!.qty).toBe(36); // 28 → 3 cases
    expect(planVariant(steady({ pack: 12, moq: 50 })).orders[0]!.qty).toBe(60); // MOQ 50 → 5 cases
    expect(planVariant(steady({ moq: 50 })).orders[0]!.qty).toBe(50);
    // A bigger order lasts longer: fewer orders in the 13 weeks.
    expect(planVariant(steady({ moq: 50 })).orders.length).toBeLessThan(planVariant(steady()).orders.length);
  });

  it("a fast seller needs several orders inside 90 days, each arriving one lead time later", () => {
    const p = planVariant(steady({ rate: 10, safety: 30, onHand: 400 }));
    expect(p.orders.length).toBeGreaterThanOrEqual(5);
    for (const o of p.orders) expect(daysBetween(o.orderBy, o.arrives)).toBe(14);
  });

  it("a seasonal ramp into November orders earlier and more than a flat year", () => {
    // Today 16 Oct; last year's weeks 4…8 (mid-Nov → mid-Dec) sold three times the base.
    const curve = [1, 1, 1, 1, 3, 3, 3, 3, 3, 1, 1, 1, 1, 1, 1, 1];
    const flat = planVariant(steady({ onHand: 200 }));
    const ramp = planVariant(steady({ onHand: 200, curve }));
    expect(ramp.deadline! < flat.deadline!).toBe(true);
    const units = (p: ReturnType<typeof planVariant>) => p.orders.reduce((a, o) => a + o.qty, 0);
    expect(units(ramp)).toBeGreaterThan(units(flat));
  });

  it("scales the seasonal shape so the first horizon sells exactly the nightly forecast", () => {
    const curve = [0.5, 1, 2, 4, null, 1];
    const s = seasonalFactors(1.6, curve, 28, 60);
    const first = s.slice(0, 28).reduce((a, b) => a + b, 0);
    expect(first).toBeCloseTo(1.6 * 28, 9);
    expect(s[0]! < s[25]!).toBe(true);
    // Beyond the curve: the stored index.
    expect(s[50]).toBe(1.6);
    // No curve: flat at the index.
    expect(seasonalFactors(1.3, null, 28, 5)).toEqual([1.3, 1.3, 1.3, 1.3, 1.3]);
// A curve computed 6 days ago is read 6 days on: day 1 is already its second week.
    const shifted = seasonalFactors(1, [1, 4], 7, 14, 6);
    expect(shifted[1]! / shifted[0]!).toBeCloseTo(4, 9);
    const fresh = seasonalFactors(1, [1, 4], 7, 14);
    expect(fresh[1]! / fresh[0]!).toBeCloseTo(1, 9);
  });
});

describe("planVariant — what can't be planned", () => {
  it("dead, not enough data and no sales get no orders and say why", () => {
    expect(planVariant(steady({ status: "dead", onHand: 0 }))).toMatchObject({ skip: "dead", orders: [], needNow: null });
    expect(planVariant(steady({ status: "not_enough_data", need: null, safety: null }))).toMatchObject({ skip: "no_data", orders: [], deadline: null });
    expect(planVariant(steady({ rate: 0 }))).toMatchObject({ skip: "no_sales", orders: [], deadline: null });
    expect(planSkip("healthy", null, null)).toBe("no_data");
    expect(planSkip("running_low", 1, 4)).toBeNull();
  });
});

describe("events, weeks and suppliers", () => {
  const plan = planVariant(steady({ onHand: 5 }));
  const ev = eventsOf(plan, { variantId: "v1", productId: "p1", supplierKey: "supplier:s1", unitCost: 2.5 });
  const noCost = eventsOf(planVariant(steady({ onHand: 60 })), { variantId: "v2", productId: "p2", supplierKey: "vendor:acme", unitCost: null });

  it("costs: unknown is null and counted, never 0", () => {
    expect(ev[0]!.cost).toBe(61 * 2.5);
    expect(noCost.every((e) => e.cost === null)).toBe(true);
    const t = cashTotals([...ev, ...noCost]);
    expect(t.missingCost).toBe(noCost.length);
    expect(t.cash).toBe(ev.reduce((a, e) => a + e.cost!, 0));
    expect(cashTotals(noCost).cash).toBeNull();
  });

  it("13 ISO weeks from today's, overdue in this week, suppliers inside", () => {
    const weeks = byWeek([...ev, ...noCost], TODAY);
    expect(weeks).toHaveLength(13);
    expect(weeks[0]!.weekStart).toBe("2026-10-12"); // Monday of 16 Oct 2026
    expect(weeks[0]!.overdue).toBe(true);
    expect(weeks[0]!.suppliers[0]!.supplierKey).toBe("supplier:s1");
    expect(planEnd(TODAY)).toBe(addDays("2026-10-12", 90));
    expect(planDays(TODAY)).toBe(daysBetween(TODAY, planEnd(TODAY)) + 1);
    const s = bySupplier([...ev, ...noCost]);
    expect(s[0]!.overdue).toBe(true);
    expect(s.find((x) => x.supplierKey === "vendor:acme")!.cash).toBeNull();
    expect(dueWithin([...ev, ...noCost], TODAY, 7).every((e) => e.orderBy <= addDays(TODAY, 6))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant: day-0 order ⇔ Order now lists it, same quantity.
// ---------------------------------------------------------------------------

function rng(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

describe("invariant: a day-0 order exactly when Order now lists the variant, with the same quantity", () => {
  it("holds over 600 random stores", () => {
    const r = rng(42);
    const statuses = ["healthy", "running_low", "out", "too_much", "dead", "not_enough_data"];
    let listed = 0;
    for (let i = 0; i < 600; i++) {
      const id = `gid://shopify/ProductVariant/${i}`;
      const status = statuses[Math.floor(r() * statuses.length)]!;
      const rate = r() < 0.1 ? 0 : Math.round(r() * 800) / 100;
      const lead = Math.floor(r() * 40);
      const cycle = Math.floor(r() * 30);
      const z = 1 + r();
      const sigma = r() * 3;
      const onHand = Math.floor(r() * 300) - 20;
      const incoming = r() < 0.4 ? Math.floor(r() * 100) : 0;
      const pack = r() < 0.4 ? Math.ceil(r() * 12) : null;
      const moq = r() < 0.3 ? Math.ceil(r() * 60) : null;
      const kehaCounted = r() < 0.2 ? Math.floor(r() * 20) : 0;
      const onOrder = kehaCounted + (r() < 0.3 ? Math.floor(r() * 30) : 0);
      const seasonal = r() < 0.5 ? 1 : 0.5 + r() * 2;
      const trend = r() < 0.5 ? 1 : 0.6 + r();
      const advice = status !== "not_enough_data";
      const safety = advice ? safetyStock(z, sigma, lead) : null;
      const need = advice ? demand(rate, { seasonal, trend, plan: 1 }, lead + cycle) + safety! - (onHand + incoming) : null;
      const orderQty = need !== null && Math.ceil(need - 1e-9) > 0 ? lineQuantity(need, pack, moq) : null;
      const inputs = { today: TODAY, seasonal, trend, plan: 1, leadTimeDays: lead, cycleDays: cycle, z, onHand, incoming, orderNeed: need, safety, kehaOnOrder: kehaCounted };
      const metric = { status, rate: advice ? rate : null, sigma: advice ? sigma : null, orderQty, inputs };
      const notCounted = Math.max(0, onOrder - kehaCounted);
      const fwd = planVariant(forwardInputFromMetric(metric, { today: TODAY, pack, moq, notCounted, days: 91 }));

      const variant: ReorderVariantIn = { id, productTitle: "P", variantTitle: "V", sku: null, vendor: "Acme", image: null, supplierId: null, caseQty: pack, cost: null, costCurrency: null };
      const m: ReorderMetricIn = { orderQty, orderBy: fwd.deadline, daysLeft: null, neverRunsOut: false, rate: metric.rate, kehaCounted, need, plannable: fwd.skip === null };
      const supplier = { id: "s1", name: "Acme", leadTimeDays: lead, minOrder: moq, minOrderTotal: null, casePack: null, vendorMatch: ["Acme"], currency: null, hasEmail: false };
      const groups = buildReorderGroups({
        variants: [variant],
        metrics: new Map([[id, m]]),
        stock: new Map(),
        onOrder: new Map([[id, onOrder]]),
        suppliers: [supplier],
        storeCurrency: "EUR",
        defaultLeadTimeDays: 14,
      });
      const line = groups[0]?.lines[0];
      const day0 = fwd.orders.find((o) => o.day === 0);
      expect(!!day0, `#${i} ${status}`).toBe(!!line);
      if (line) {
        listed++;
        expect(line.suggested, `#${i}`).toBe(day0!.qty);
        expect(line.orderBy).toBe(fwd.deadline);
      }
    }
    expect(listed).toBeGreaterThan(100);
  });

  it("holds for computeVariant's own numbers (series in, stored metric out)", () => {
    for (const onHand of [0, 10, 40, 75, 200])
      for (const incoming of [0, 30]) {
        const res = computeVariant(variantInput({ series: buildSeries({ days: 90, sold: (k) => (k % 2 ? 1 : 3) }), onHand, incoming, supplierLeadTimeDays: 16, caseQty: 6 }))!;
        const metric = { status: res.status, rate: res.rate, sigma: res.sigma, orderQty: res.orderQty, inputs: { ...res.inputs, safety: res.safety } };
        const fwd = planVariant(forwardInputFromMetric(metric, { today: TODAY, pack: 6, moq: null, notCounted: 0, days: 91 }));
        const day0 = fwd.orders.find((o) => o.day === 0);
        expect(!!day0, `${onHand}/${incoming}`).toBe((res.orderQty ?? 0) > 0);
        if (day0) expect(day0.qty).toBe(res.orderQty);
      }
  });
});
