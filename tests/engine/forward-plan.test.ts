/**
 * Forward order plan (engine/forward-plan-shared): fixtures for the day-by-day projection, the
 * order-by date, orders placed on it (audit 2026-10-17), the supplier minimums in the plan, and
 * the invariant that ties it to Order now and the Dashboard.
 */
import { describe, expect, it } from "vitest";
import {
  batchWindows,
  byWeek,
  bySupplier,
  cashTotals,
  dueWithin,
  eventsOf,
  forwardInputFromMetric,
  planDays,
  planEnd,
  planSkip,
  planStore,
  planVariant,
  seasonalFactors,
  splitByShare,
  topUpToValue,
  type ForwardVariantInput,
  type PlanSupplierRules,
  type PlanVariantSpec,
} from "../../app/lib/engine/forward-plan-shared";
import { addDays, daysBetween } from "../../app/lib/engine/dates-shared";
import { demand, lineQuantity, orderByDate, safetyStock } from "../../app/lib/engine/order-shared";
import { computeVariant } from "../../app/lib/engine/index-shared";
import { buildOrderNow } from "../../app/lib/reorder-shared";
import { thisWeek } from "../../app/lib/order-plan-shared";
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

describe("rows saved before the plan stored safety (L3)", () => {
  it("safety falls back to z × σ × √(lead time + cycle), as the engine and the product page compute it", () => {
    const m = { status: "healthy", rate: 2, sigma: 3, orderQty: 10, inputs: { leadTimeDays: 14, cycleDays: 14, z: 1.28, onHand: 40, incoming: 0, orderNeed: 20 } };
    const input = forwardInputFromMetric(m, { today: "2026-10-16", pack: null, moq: null, notCounted: 0, days: 91 });
    expect(input.safety).toBeCloseTo(safetyStock(1.28, 3, 28));
    expect(input.safety).not.toBeCloseTo(safetyStock(1.28, 3, 14));
    // A stored safety always wins.
    expect(forwardInputFromMetric({ ...m, inputs: { ...m.inputs, safety: 7 } }, { today: "2026-10-16", pack: null, moq: null, notCounted: 0, days: 91 }).safety).toBe(7);
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
// Audit 2026-10-17: an order is placed ON its order-by date (C3, merchant #1)
// ---------------------------------------------------------------------------

describe("orders are placed on their order-by date, never earlier", () => {
  it("failing scenario: stock below demand(lead + cycle) + safety, deadline 11 days out → no order today", () => {
    // 60 on hand, 2/day, lead 14, cycle 14, safety 10: need today = 56 + 10 − 60 = 6 > 0, and the
    // old rule ordered today (and every day until the deadline). The deadline is day 11.
    const p = planVariant(steady({ onHand: 60 }));
    expect(p.deadline).toBe(addDays(TODAY, 11));
    expect(p.orders[0]!.day).toBe(11);
    expect(p.orders[0]).toMatchObject({ orderBy: addDays(TODAY, 11), deadline: addDays(TODAY, 11), overdue: false });
    expect(p.orders.some((o) => o.day === 0)).toBe(false);
  });

  it("a deadline today is ordered today and not overdue; a passed one is ordered today, overdue", () => {
    const due = planVariant(steady({ onHand: 38 })); // (38 − 10) ÷ 2 − 14 = 0
    expect(due.deadline).toBe(TODAY);
    expect(due.orders[0]).toMatchObject({ day: 0, overdue: false, deadline: TODAY });
    const late = planVariant(steady({ onHand: 5 }));
    expect(late.orders[0]).toMatchObject({ day: 0, overdue: true });
  });

  it("simulated day by day, ordering whatever is due each day orders as often as the calendar (not 91 times)", () => {
    // Each morning: re-plan from the stock that is really there, order what is due today, receive it a lead time later.
    const rate = 2;
    let onHand = 120;
    const arrivals: { day: number; units: number }[] = [];
    let simulated = 0;
    const calendar = planVariant(steady({ onHand: 120, days: 91 })).orders.length;
    for (let d = 0; d < 91; d++) {
      onHand += arrivals.filter((a) => a.day === d).reduce((x, a) => x + a.units, 0);
      const pending = arrivals.filter((a) => a.day > d);
      const today = addDays(TODAY, d);
      const incoming = pending.reduce((x, a) => x + a.units, 0);
      const p = planVariant(
        steady({ today, onHand, incoming, arrivals: pending.map((a) => ({ day: addDays(TODAY, a.day), units: a.units })), days: 1 }),
      );
      const o = p.orders.find((x) => x.day === 0);
      if (o) {
        simulated++;
        arrivals.push({ day: d + 14, units: o.qty });
      }
      onHand -= rate;
    }
    expect(calendar).toBeGreaterThan(0);
    expect(simulated).toBeLessThanOrEqual(calendar + 1);
    expect(simulated).toBeGreaterThanOrEqual(calendar - 1);
  });

  it("each order keeps the terms of its quantity (Why this quantity), adding up to the need", () => {
    const p = planVariant(steady({ onHand: 5, pack: 12 }));
    const w = p.orders[0]!.why!;
    expect(w).toMatchObject({ day: 0, days: 28, rate: 2, season: 1, growth: 1, safety: 10, onHand: 5, onOrder: 0, pack: 12, rounded: 72, topUp: 0 });
    expect(w.demand).toBeCloseTo(56, 9);
    expect(w.need).toBeCloseTo(w.demand + w.safety - w.onHand - w.onOrder, 9);
    const later = p.orders[1]!.why!;
    expect(later.day).toBe(p.orders[1]!.day);
    expect(later.need).toBeCloseTo(later.demand + later.safety - later.onHand - later.onOrder, 9);
  });
});

// ---------------------------------------------------------------------------
// Supplier minimums in the plan itself (merchant #2, #3): planStore
// ---------------------------------------------------------------------------

const spec = (n: number, over: Partial<ForwardVariantInput> = {}, x: { product?: string; cost?: number | null; weight?: number; key?: string } = {}): PlanVariantSpec => ({
  variantId: `v${n}`,
  productId: x.product ?? `p${n}`,
  supplierKey: x.key ?? "supplier:s1",
  unitCost: x.cost === undefined ? 2 : x.cost,
  weight: x.weight ?? over.rate ?? 2,
  input: steady(over),
});

describe("planStore: the supplier's minimums, batch by batch", () => {
  it("without minimums: exactly planVariant's orders", () => {
    const specs = [spec(1, { onHand: 5 }), spec(2, { onHand: 60, rate: 3 }), spec(3, { onHand: 300, rate: 1 })];
    const store = planStore(specs, {}, TODAY);
    for (const s of specs) {
      const own = planVariant(s.input).orders.map((o) => [o.orderBy, o.qty]);
      expect(store.events.filter((e) => e.variantId === s.variantId).map((e) => [e.orderBy, e.qty])).toEqual(own);
    }
  });

  it("batches: the next 7 days (Order now), then every 7 days", () => {
    expect(batchWindows(20)).toEqual([[0, 6], [7, 13], [14, 19]]);
    expect(batchWindows(0)).toEqual([]);
  });

  it("order minimum in units: topped up in the plan, so later orders move out", () => {
    const specs = [spec(1, { onHand: 5 }), spec(2, { onHand: 10 })];
    const plain = planStore(specs, {}, TODAY);
    const min = planStore(specs, { "supplier:s1": { styleMin: null, minTotal: 300, minValue: null } }, TODAY);
    const now = (p: typeof min) => dueWithin(p.events, TODAY, 7);
    expect(now(min).reduce((a, e) => a + e.qty, 0)).toBeGreaterThanOrEqual(300);
    expect(min.batches[0]).toMatchObject({ supplierKey: "supplier:s1", toppedUp: true });
    expect(now(min).every((e) => (e.why?.topUp ?? 0) >= 0)).toBe(true);
    // The extra units arrive with this order: the next order of each variant comes later.
    const next = (p: typeof min, id: string) => p.events.find((e) => e.variantId === id && e.orderBy > addDays(TODAY, 6))?.orderBy ?? "9999";
    expect(next(min, "v1") > next(plain, "v1")).toBe(true);
  });

  it("order minimum in money (store currency): topped up by value, whole case packs; lines without a cost don't take any", () => {
    const specs = [spec(1, { onHand: 5, pack: 6 }, { cost: 10 }), spec(2, { onHand: 10 }, { cost: null })];
    const r = planStore(specs, { "supplier:s1": { styleMin: null, minTotal: null, minValue: 2000 } }, TODAY);
    const now = dueWithin(r.events, TODAY, 7);
    const v1 = now.find((e) => e.variantId === "v1")!;
    const v2 = now.find((e) => e.variantId === "v2")!;
    expect(v1.qty * 10).toBeGreaterThanOrEqual(2000);
    expect(v1.qty % 6).toBe(0);
    expect(v2.why!.topUp).toBe(0);
    expect(r.batches[0]!.valueToppedUp).toBe(true);
    expect(cashTotals(now)).toMatchObject({ missingCost: 1 });
  });

  it("minimum per style: a product's sizes share it by share of sales (largest remainder, whole packs), sizes not due join", () => {
    // Shirt: S overdue (2/day), M healthy (6/day), L healthy (2/day); minimum 120 per style, packs of 1.
    const specs = [
      spec(1, { onHand: 5 }, { product: "shirt", weight: 2 }),
      spec(2, { onHand: 900, rate: 6 }, { product: "shirt", weight: 6 }),
      spec(3, { onHand: 400, rate: 2 }, { product: "shirt", weight: 2 }),
    ];
    const r = planStore(specs, { "supplier:s1": { styleMin: 120, minTotal: null, minValue: null } }, TODAY);
    const now = dueWithin(r.events, TODAY, 7);
    expect(now.reduce((a, e) => a + e.qty, 0)).toBe(120);
    const q = Object.fromEntries(now.map((e) => [e.variantId, e.qty]));
    // S needs 61; the other 59 split 2 : 6 : 2 → 11.8, 35.4, 11.8 → 12, 35, 12 (largest remainder).
    expect(q).toEqual({ v1: 61 + 12, v2: 35, v3: 12 });
    expect(r.batches[0]!.styleToppedUp).toEqual(["shirt"]);
  });

  it("splitByShare: largest remainder, whole packs, equal shares without weights", () => {
    expect(splitByShare(10, [{ weight: 1, pack: null }, { weight: 1, pack: null }, { weight: 1, pack: null }])).toEqual([4, 3, 3]);
    expect(splitByShare(10, [{ weight: 3, pack: 4 }, { weight: 1, pack: 4 }])).toEqual([8, 4]);
    expect(splitByShare(5, [{ weight: 0, pack: null }, { weight: 0, pack: null }])).toEqual([3, 2]);
    expect(splitByShare(0, [{ weight: 1, pack: null }])).toEqual([0]);
  });

  it("topUpToValue: nothing to raise without costs; reaches the value otherwise", () => {
    expect(topUpToValue([{ qty: 4, pack: null, weight: 1, unitCost: null }], 100)).toEqual({ qtys: [4], toppedUp: false });
    const r = topUpToValue([{ qty: 4, pack: 2, weight: 1, unitCost: 5 }, { qty: 2, pack: null, weight: 3, unitCost: 10 }], 200);
    expect(r.qtys[0]! * 5 + r.qtys[1]! * 10).toBeGreaterThanOrEqual(200);
    expect(r.qtys[0]! % 2).toBe(0);
    expect(r.toppedUp).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant: Order now ⇔ the plan's orders due in the next 7 days, same quantities.
// ---------------------------------------------------------------------------

function rng(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

describe("invariant: Order now lists exactly the plan's orders due in the next 7 days, with the same quantities", () => {
  it("holds over 600 random variants in random suppliers with random minimums", () => {
    const r = rng(42);
    const statuses = ["healthy", "running_low", "out", "too_much", "dead", "not_enough_data"];
    const specs: PlanVariantSpec[] = [];
    const rules: Record<string, PlanSupplierRules> = {};
    for (let k = 0; k < 6; k++) {
      rules[`supplier:s${k}`] = {
        styleMin: r() < 0.3 ? Math.ceil(r() * 80) : null,
        minTotal: r() < 0.4 ? Math.ceil(r() * 200) : null,
        minValue: r() < 0.3 ? Math.ceil(r() * 500) : null,
      };
    }
    for (let i = 0; i < 600; i++) {
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
      const seasonal = r() < 0.5 ? 1 : 0.5 + r() * 2;
      const advice = status !== "not_enough_data";
      const safety = advice ? safetyStock(z, sigma, lead) : null;
      const need = advice ? demand(rate, { seasonal, trend: 1, plan: 1 }, lead + cycle) + safety! - (onHand + incoming) : null;
      const orderQty = need !== null && Math.ceil(need - 1e-9) > 0 ? lineQuantity(need, pack, moq) : null;
      const metric = { status, rate: advice ? rate : null, sigma: advice ? sigma : null, orderQty, inputs: { today: TODAY, seasonal, trend: 1, plan: 1, leadTimeDays: lead, cycleDays: cycle, z, onHand, incoming, orderNeed: need, safety } };
      specs.push({
        variantId: `gid://shopify/ProductVariant/${i}`,
        productId: `p${Math.floor(i / 3)}`,
        supplierKey: `supplier:s${i % 6}`,
        unitCost: r() < 0.2 ? null : Math.round(r() * 2000) / 100,
        weight: rate,
        input: forwardInputFromMetric(metric, { today: TODAY, pack, moq, notCounted: r() < 0.2 ? Math.floor(r() * 20) : 0, days: 91 }),
      });
    }
    const store = planStore(specs, rules, TODAY);
    const info = Object.fromEntries(specs.map((s) => [s.variantId, { variantId: s.variantId, productId: s.productId, productTitle: s.productId, variantTitle: s.variantId, sku: null, image: null, daysLeft: null, neverRunsOut: false, deadline: null, valuePerDay: null }]));
    const plan = { today: TODAY, events: store.events, variants: info, suppliers: {}, batches: store.batches, currency: "EUR" };
    const groups = buildOrderNow({ plan, stock: new Map(), onOrder: new Map() });
    const due = dueWithin(store.events, TODAY, 7);
    const sum = new Map<string, number>();
    for (const e of due) sum.set(e.variantId, (sum.get(e.variantId) ?? 0) + e.qty);
    const lines = new Map(groups.flatMap((g) => g.lines.map((l) => [l.variantId, l.suggested] as const)));
    expect([...lines].sort()).toEqual([...sum].sort());
    expect(lines.size).toBeGreaterThan(50);
    // …and the Dashboard's "Order this week" is the same orders: same units, same cash.
    const week = thisWeek(plan);
    expect(week.totals.units).toBe([...sum.values()].reduce((a, b) => a + b, 0));
    expect(week.totals.cash).toBe(cashTotals(due).cash);
  });

  it("holds for computeVariant's own numbers (series in, stored metric out)", () => {
    for (const onHand of [0, 10, 40, 75, 200])
      for (const incoming of [0, 30]) {
        const res = computeVariant(variantInput({ series: buildSeries({ days: 90, sold: (k) => (k % 2 ? 1 : 3) }), onHand, incoming, supplierLeadTimeDays: 16, caseQty: 6 }))!;
        const metric = { status: res.status, rate: res.rate, sigma: res.sigma, orderQty: res.orderQty, inputs: { ...res.inputs, safety: res.safety } };
        const fwd = planVariant(forwardInputFromMetric(metric, { today: TODAY, pack: 6, moq: null, notCounted: 0, days: 91 }));
        const day0 = fwd.orders.find((o) => o.day === 0);
        // An order today exactly when the order-by date is today or has passed.
        expect(!!day0, `${onHand}/${incoming}`).toBe(fwd.deadline !== null && fwd.deadline <= TODAY);
        // …at the plan's own need for today (stored need), rounded to the case pack.
        if (day0) expect(day0.qty).toBe(lineQuantity(res.inputs.orderNeed!, 6, null));
      }
  });
});
