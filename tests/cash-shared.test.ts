/**
 * Cash, pure part (lib/cash-shared; supplier module, Kanwar 2026-10-17): payment terms, landed
 * cost, the payments of a planned and an open order, the cash per week / month with "to plan" and
 * "committed", and the "Fit to budget" suggestion (lowest priority first, minimums never broken).
 */
import { describe, expect, it } from "vitest";
import {
  balanceDay,
  cashMonths,
  cashSummary,
  cashWeeks,
  deferPriority,
  fitToBudget,
  landedOf,
  landedText,
  nextMonthStart,
  openOrderPayments,
  orderPayments,
  paymentsOf,
  readLandedPct,
  readPaymentTerms,
  shipDayOf,
  termsText,
  withPayments,
  type FitEvent,
  type FitInput,
} from "../app/lib/cash-shared";
import { cashTotals, type PlanEvent } from "../app/lib/engine/forward-plan-shared";

const t = (s: string) => s;
const TODAY = "2026-10-19"; // a Monday

describe("payment terms", () => {
  it("reads the stored columns; no balance moment or 100 % up front = no terms", () => {
    expect(readPaymentTerms({ depositPercent: 30, balanceDue: "ship", balanceDays: null })).toEqual({ depositPct: 30, balanceDue: "ship", balanceDays: 0 });
    expect(readPaymentTerms({ depositPercent: null, balanceDue: "after_arrival", balanceDays: 30 })).toEqual({ depositPct: 0, balanceDue: "after_arrival", balanceDays: 30 });
    expect(readPaymentTerms({ depositPercent: 30, balanceDue: null })).toBeNull();
    expect(readPaymentTerms({ depositPercent: 100, balanceDue: "arrival" })).toBeNull();
    expect(readPaymentTerms({ depositPercent: 30, balanceDue: "later" })).toBeNull();
    expect(readPaymentTerms(null)).toBeNull();
    // Days only for "after arrival".
    expect(readPaymentTerms({ depositPercent: 0, balanceDue: "arrival", balanceDays: 30 })!.balanceDays).toBe(0);
  });

  it("texts", () => {
    expect(termsText(null, t)).toBe("Paid when you order");
    expect(termsText({ depositPct: 30, balanceDue: "ship", balanceDays: 0 }, t)).toBe("30% deposit, 70% at shipment");
    expect(termsText({ depositPct: 50, balanceDue: "arrival", balanceDays: 0 }, t)).toBe("50% deposit, 50% on arrival");
    expect(termsText({ depositPct: 20, balanceDue: "after_arrival", balanceDays: 30 }, t)).toBe("20% deposit, 80% 30 days after arrival");
    expect(termsText({ depositPct: 0, balanceDue: "after_arrival", balanceDays: 60 }, t)).toBe("Paid 60 days after arrival");
    expect(termsText({ depositPct: 0, balanceDue: "ship", balanceDays: 0 }, t)).toBe("Paid at shipment");
    expect(landedText(12, t, "en")).toBe("+ 12% freight & duty");
    expect(landedText(null, t, "en")).toBe("");
  });

  it("landed cost: % of the goods, unknown stays unknown", () => {
    expect(readLandedPct("12.50")).toBe(12.5);
    expect(readLandedPct(0)).toBeNull();
    expect(readLandedPct(null)).toBeNull();
    expect(landedOf(1000, 12)).toBe(120);
    expect(landedOf(null, 12)).toBeNull();
    expect(landedOf(1000, null)).toBeNull();
  });
});

describe("the payments of one order", () => {
  const m = { orderDay: TODAY, arrives: "2026-12-03", transitDays: 30 };

  it("no terms: the goods the day it is ordered (as before terms existed); freight + duty on arrival", () => {
    expect(orderPayments(m, 1000, null, null)).toEqual([{ day: TODAY, amount: 1000, kind: "order" }]);
    expect(orderPayments(m, 1000, 120, null)).toEqual([
      { day: TODAY, amount: 1000, kind: "order" },
      { day: "2026-12-03", amount: 120, kind: "landed" },
    ]);
    // Unknown cost: no goods payment (never 0).
    expect(orderPayments(m, null, null, null)).toEqual([]);
  });

  it("30 % deposit, 70 % at shipment: the ship date is arrival − transit days; the parts add up to the goods", () => {
    const terms = { depositPct: 30, balanceDue: "ship" as const, balanceDays: 0 };
    expect(shipDayOf(m)).toBe("2026-11-03");
    const p = orderPayments(m, 999.99, null, terms);
    expect(p).toEqual([
      { day: TODAY, amount: 300, kind: "deposit" },
      { day: "2026-11-03", amount: 699.99, kind: "balance" },
    ]);
    expect(p.reduce((a, x) => a + x.amount, 0)).toBeCloseTo(999.99, 9);
    // No transit: it ships on arrival; never before the order day.
    expect(shipDayOf({ orderDay: TODAY, arrives: "2026-11-01" })).toBe("2026-11-01");
    expect(shipDayOf({ orderDay: TODAY, arrives: "2026-10-25", transitDays: 30 })).toBe(TODAY);
    // A confirmed ship date wins.
    expect(shipDayOf({ ...m, shipDay: "2026-11-10" })).toBe("2026-11-10");
  });

  it("balance on arrival / N days after arrival", () => {
    expect(balanceDay({ depositPct: 0, balanceDue: "arrival", balanceDays: 0 }, m)).toBe("2026-12-03");
    expect(balanceDay({ depositPct: 0, balanceDue: "after_arrival", balanceDays: 30 }, m)).toBe("2027-01-02");
    // 0 % deposit: one payment.
    expect(orderPayments(m, 500, null, { depositPct: 0, balanceDue: "arrival", balanceDays: 0 })).toEqual([{ day: "2026-12-03", amount: 500, kind: "balance" }]);
  });

  it("withPayments: every event gets its freight + duty and payments from its supplier; no terms keeps one payment on the order day", () => {
    const events = [
      { supplierKey: "supplier:a", orderBy: TODAY, arrives: "2026-11-18", cost: 100 },
      { supplierKey: "vendor:x", orderBy: TODAY, arrives: "2026-11-18", cost: 50 },
    ] as (Pick<PlanEvent, "supplierKey" | "orderBy" | "arrives" | "cost"> & { landed?: number | null; payments?: ReturnType<typeof paymentsOf> })[];
    withPayments(events, { "supplier:a": { terms: { depositPct: 30, balanceDue: "arrival", balanceDays: 0 }, landedPct: 10, transitDays: null } });
    expect(events[0]).toMatchObject({ landed: 10, payments: [{ day: TODAY, amount: 30, kind: "deposit" }, { day: "2026-11-18", amount: 70, kind: "balance" }, { day: "2026-11-18", amount: 10, kind: "landed" }] });
    expect(events[1]).toMatchObject({ landed: null, payments: [{ day: TODAY, amount: 50, kind: "order" }] });
    // Freight + duty is in the cash totals, shown separately.
    expect(cashTotals([{ qty: 5, cost: 100, landed: 10 }, { qty: 2, cost: 50, landed: null }])).toEqual({ units: 7, cash: 160, landed: 10, missingCost: 0, lines: 2 });
    expect(cashTotals([{ qty: 5, cost: 100 }])).toEqual({ units: 5, cash: 100, missingCost: 0, lines: 1 });
    // Rows without payments: the cost + freight on the order day.
    expect(paymentsOf({ orderBy: TODAY, cost: 40, landed: 4 })).toEqual([{ day: TODAY, amount: 44, kind: "order" }]);
  });

  it("an open order: its deposit was paid when sent; the balance and freight still due, a passed day due today", () => {
    const base = { id: "po1", number: "PO-0007", supplierKey: "supplier:a", sentDay: "2026-09-01", shipDay: null, arrives: "2026-11-20", goods: 1000 };
    const money = { terms: { depositPct: 30, balanceDue: "ship" as const, balanceDays: 0 }, landedPct: 12, transitDays: 30 };
    expect(openOrderPayments({ ...base, money }, TODAY)).toEqual([
      // Ship date 21 Oct (arrival − 30 days).
      { day: "2026-10-21", amount: 700, kind: "balance", supplierKey: "supplier:a", po: "po1", number: "PO-0007" },
      { day: "2026-11-20", amount: 120, kind: "landed", supplierKey: "supplier:a", po: "po1", number: "PO-0007" },
    ]);
    // The supplier confirmed it shipped on 10 Oct and it hasn't arrived: the balance is due now.
    expect(openOrderPayments({ ...base, shipDay: "2026-10-10", money }, TODAY)[0]).toMatchObject({ day: TODAY, amount: 700 });
    // No terms: everything was paid when it was sent.
    expect(openOrderPayments({ ...base, money: { terms: null, landedPct: null, transitDays: null } }, TODAY)).toEqual([]);
  });
});

describe("cash per week and month", () => {
  const events = [
    { orderBy: TODAY, cost: 100, payments: [{ day: TODAY, amount: 30, kind: "deposit" as const }, { day: "2026-11-02", amount: 70, kind: "balance" as const }] },
    { orderBy: "2026-10-28", cost: 50, payments: [{ day: "2026-10-28", amount: 50, kind: "order" as const }, { day: "2027-03-01", amount: 5, kind: "landed" as const }] },
  ];
  const committed = [{ day: "2026-10-21", amount: 700, kind: "balance" as const }];

  it("each payment in the week it is paid; to plan vs committed; what falls after the weeks shown", () => {
    const w = cashWeeks(events, committed, TODAY, 13);
    expect(w).toHaveLength(13);
    expect(w[0]).toMatchObject({ weekStart: "2026-10-19", toPlan: 30, committed: 700, total: 730, landed: 0 });
    expect(w[1]).toMatchObject({ weekStart: "2026-10-26", toPlan: 50, committed: 0, total: 50 });
    expect(w[2]).toMatchObject({ weekStart: "2026-11-02", toPlan: 70, total: 70 });
    expect(cashSummary(events, committed, TODAY, 13)).toEqual({ toPlan: 150, committed: 700, total: 850, landed: 0, later: 5, any: true });
    // Without terms (one payment on the order day) the weeks are the cost per order week, as before.
    const plain = cashWeeks([{ orderBy: TODAY, cost: 100 }], [], TODAY, 2);
    expect(plain.map((x) => x.total)).toEqual([100, 0]);
  });

  it("months touching the next 13 weeks, partial at both ends", () => {
    const end = "2027-01-17";
    const m = cashMonths(events, committed, TODAY, end);
    expect(m.map((x) => [x.month, x.from, x.to, x.partial])).toEqual([
      ["2026-10", TODAY, "2026-10-31", true],
      ["2026-11", "2026-11-01", "2026-11-30", false],
      ["2026-12", "2026-12-01", "2026-12-31", false],
      ["2027-01", "2027-01-01", end, true],
    ]);
    expect(m[0]).toMatchObject({ toPlan: 80, committed: 700, total: 780 });
    expect(m[1]).toMatchObject({ toPlan: 70, total: 70 });
    expect(nextMonthStart("2026-12-15")).toBe("2027-01-01");
  });
});

describe("fit to budget", () => {
  const ev = (n: number, o: Partial<FitEvent> & { amount: number }): FitEvent => ({
    variantId: `V${n}`,
    productId: o.productId ?? `P${n}`,
    supplierKey: o.supplierKey ?? "supplier:a",
    orderBy: o.orderBy ?? "2026-10-20",
    arrives: o.arrives ?? "2026-11-20",
    qty: o.qty ?? 10,
    cost: o.amount,
    overdue: o.overdue ?? false,
    payments: [{ day: o.orderBy ?? "2026-10-20", amount: o.amount, kind: "order" }],
  });
  const base = (events: FitEvent[], over: Partial<FitInput> = {}): FitInput => ({
    today: TODAY,
    end: "2027-01-17",
    budget: 1000,
    events,
    committed: [],
    variants: {
      V1: { valuePerDay: 100, daysLeft: 5 }, // priority 20
      V2: { valuePerDay: 10, daysLeft: 50 }, // 0.2
      V3: { valuePerDay: 30, daysLeft: 30 }, // 1
      V4: { valuePerDay: null, daysLeft: 10 }, // can't be ranked
    },
    batches: [{ supplierKey: "supplier:a", from: TODAY, to: "2026-10-25", toppedUp: false, valueToppedUp: false, styleToppedUp: [] }],
    rules: {},
    ...over,
  });

  it("priority = money at stake per day ÷ days until it runs out", () => {
    expect(deferPriority({ valuePerDay: 100, daysLeft: 5 })).toBe(20);
    expect(deferPriority({ valuePerDay: 100, daysLeft: 0.2 })).toBe(100);
    expect(deferPriority({ valuePerDay: null, daysLeft: 5 })).toBeNull();
    expect(deferPriority({ valuePerDay: 10, daysLeft: null, neverRunsOut: true })).toBeCloseTo(10 / 365, 9);
    expect(deferPriority(undefined)).toBeNull();
  });

  it("defers the lowest-priority lines to next month until the month fits; never the unrankable or overdue", () => {
    const events = [ev(1, { amount: 600 }), ev(2, { amount: 500 }), ev(3, { amount: 300 }), ev(4, { amount: 200 })];
    const [oct, ...rest] = fitToBudget(base(events));
    expect(rest).toEqual([]);
    expect(oct).toMatchObject({ month: "2026-10", total: 1600, budget: 1000, overBy: 600, fits: true });
    // V2 (0.2) then V3 (1): 1600 − 500 − 300 = 800.
    expect(oct!.deferrals.map((d) => [d.variantId, d.from, d.to, d.amount, d.wholeOrder])).toEqual([
      ["V2", "2026-10-20", "2026-11-01", 500, false],
      ["V3", "2026-10-20", "2026-11-01", 300, false],
    ]);
    expect(oct!.after).toBe(800);
    // V2 has 50 days of stock: the deferred order still arrives in time; V3 runs out 18 Nov, arrives 2 Dec.
    expect(oct!.deferrals[0]!.lateDays).toBe(0);
    expect(oct!.deferrals[1]!.lateDays).toBe(14);
    // Overdue lines stay.
    const late = fitToBudget(base([ev(1, { amount: 600 }), ev(2, { amount: 500, overdue: true })]));
    expect(late[0]!.deferrals.map((d) => d.variantId)).toEqual(["V1"]);
    // Nothing over budget: nothing suggested; no budget: nothing at all.
    expect(fitToBudget(base([ev(1, { amount: 600 })]))).toEqual([]);
    expect(fitToBudget(base(events, { budget: 0 }))).toEqual([]);
  });

  it("minimums: a line goes alone only when what stays meets them; else the whole supplier order moves", () => {
    const events = [ev(1, { amount: 600, qty: 30 }), ev(2, { amount: 500, qty: 30 })];
    // 50 units per order: neither line can leave alone (30 < 50), so the whole order is deferred.
    const r = fitToBudget(base(events, { rules: { "supplier:a": { minTotal: 50, minValue: null, styleMin: null } } }));
    expect(r[0]!.deferrals.map((d) => [d.variantId, d.wholeOrder])).toEqual([
      ["V1", true],
      ["V2", true],
    ]);
    expect(r[0]).toMatchObject({ after: 0, fits: true });
    // An order of 100 units: V2 can go (70 stay ≥ 50) — but alone it is below the minimum and the
    // supplier has no order next month to join, so it can't; with one in November it joins it.
    const three = [ev(1, { amount: 600, qty: 40 }), ev(2, { amount: 500, qty: 30 }), ev(3, { amount: 10, qty: 30 })];
    const rules = { "supplier:a": { minTotal: 50, minValue: null, styleMin: null } };
    const alone = fitToBudget(base(three, { rules, budget: 700 }));
    expect(alone[0]!.deferrals.every((d) => d.wholeOrder)).toBe(true);
    const nov = ev(5, { amount: 100, orderBy: "2026-11-09" });
    const joined = fitToBudget(base([...three, nov], { rules, budget: 700 }));
    expect(joined[0]!.deferrals.map((d) => [d.variantId, d.to, d.wholeOrder])).toEqual([["V2", "2026-11-09", false]]);
    expect(joined[0]!.after).toBe(610);
  });

  it("committed cash can't be deferred: the month may stay over; what moves out counts in the next month", () => {
    const events = [ev(2, { amount: 500 })];
    const r = fitToBudget(base(events, { committed: [{ day: "2026-10-22", amount: 1200, kind: "balance" }] }));
    expect(r[0]).toMatchObject({ month: "2026-10", total: 1700, after: 1200, fits: false });
    // November then holds the deferred 500 (within budget: no November entry).
    expect(r).toHaveLength(1);
  });
});
