/**
 * Clarity pass (Kanwar 2026-10-23): one status vocabulary for every screen (lib/outcome-shared),
 * the plain "why this quantity", the plan basis said once, stock-first actions and the
 * first-session measurement. Pure.
 */
import { describe, expect, it } from "vitest";
import { outcomeOf, outcomeReasonText, outcomeLabel, outcomeTone, paceText, planOutcome, verdictText, worstOutcome, type Outcome } from "../app/lib/outcome-shared";
import { planDays, planVariant, type ForwardVariantInput } from "../app/lib/engine/forward-plan-shared";
import { demand } from "../app/lib/engine/order-shared";
import { whyPlain } from "../app/lib/order-plan-shared";
import { planBasisParts } from "../app/lib/plan-basis-shared";
import { activationSummary } from "../app/lib/activation-shared";
import { stockFirst } from "../app/components/action-list";
import { translate } from "../app/lib/i18n";

const TODAY = "2026-10-16";
const id = (s: string) => s;
const day = (d: string) => d;

function plan(over: Partial<ForwardVariantInput>) {
  const b = { today: TODAY, status: "healthy", rate: 2, seasonal: 1, trend: 1, plan: 1, curve: null, safety: 10, leadTimeDays: 14, cycleDays: 14, onHand: 100, incoming: 0, arrivals: [], pack: null, moq: null, days: planDays(TODAY), ...over };
  return planVariant({ ...b, need: demand(b.rate!, { seasonal: 1, trend: 1, plan: 1 }, b.leadTimeDays + b.cycleDays) + b.safety! - (b.onHand + b.incoming) } as ForwardVariantInput);
}

describe("StockOutlook (the forward plan's one fact behind every status word)", () => {
  it("runs out before an order placed today could arrive: the day the last unit sells, and that order's arrival", () => {
    const p = plan({ onHand: 5 }); // 2 a day: Oct 16, 17 and the last unit on Oct 18
    expect(p.outlook).toEqual({ outNow: false, runsOut: "2026-10-18", beforeArrival: true, arrives: "2026-10-30" });
    expect(p.overdue).toBe(true);
  });
  it("lasts past a new order's arrival: not before arrival, even when only the buffer is short", () => {
    const p = plan({ onHand: 40 }); // 20 days > 14-day lead time
    expect(p.outlook).toMatchObject({ outNow: false, runsOut: "2026-11-04", beforeArrival: false });
  });
  it("sold out today", () => {
    expect(plan({ onHand: 0 }).outlook).toMatchObject({ outNow: true, beforeArrival: true });
  });
  it("an order already on the way: the gap is counted, the order isn't due yet", () => {
    const p = plan({ onHand: 6, incoming: 60, arrivals: [{ day: "2026-10-26", units: 60 }] });
    expect(p.outlook).toMatchObject({ outNow: false, runsOut: "2026-10-18", beforeArrival: true });
    expect(p.overdue).toBe(false);
  });
});

describe("outcomeOf: the words", () => {
  const base = { status: "healthy" as const, today: TODAY };
  it("live 2026-10-23: a tote with 64 days of stock is never red — at most Order soon for its buffer", () => {
    const o = outcomeOf({ ...base, orderBy: "2026-10-12", overdue: true, outlook: { outNow: false, runsOut: "2026-12-19", beforeArrival: false, arrives: "2026-10-30" } });
    expect(o).toEqual({ key: "orderSoon", reason: { kind: "buffer", lasts: "2026-12-19" } });
    expect(outcomeTone(o.key)).toBe("warning");
  });
  it("runs out before a new order could arrive and its order is due: Order now, with both days", () => {
    const o = outcomeOf({ ...base, orderBy: null, overdue: true, outlook: { outNow: false, runsOut: "2026-10-18", beforeArrival: true, arrives: "2026-10-30" } });
    expect(o).toEqual({ key: "orderNow", reason: { kind: "runsOutFirst", runsOut: "2026-10-18", arrives: "2026-10-30" } });
    expect(outcomeReasonText(o.reason, id, day)).toBe("Runs out 2026-10-18 · a new order would arrive 2026-10-30");
  });
  it("runs out until an order already on the way arrives, next order not due yet: Order soon, never red", () => {
    const o = outcomeOf({ ...base, orderBy: "2026-10-24", overdue: false, outlook: { outNow: false, runsOut: "2026-10-18", beforeArrival: true, arrives: "2026-10-30" } });
    expect(o).toEqual({ key: "orderSoon", reason: { kind: "waitsForOrder", runsOut: "2026-10-18" } });
    expect(outcomeReasonText(o.reason, id, day)).toBe("Runs out 2026-10-18 until the stock on order arrives");
  });
  it("sold out: Order now with the day it sold out; dead stock that is out stays Not selling", () => {
    expect(outcomeOf({ ...base, soldOutSince: "2026-10-10", outlook: { outNow: true, runsOut: TODAY, beforeArrival: true, arrives: "2026-10-30" } })).toEqual({
      key: "orderNow",
      reason: { kind: "soldOut", since: "2026-10-10" },
    });
    expect(outcomeOf({ status: "out", today: TODAY }).key).toBe("orderNow");
    expect(outcomeOf({ status: "dead", today: TODAY, onHand: 0 }).key).toBe("notSelling");
  });
  it("order-by within a week: Order soon with the date; later: OK with the next order", () => {
    const later = { outNow: false, runsOut: "2026-12-01", beforeArrival: false, arrives: "2026-10-30" };
    expect(outcomeOf({ ...base, orderBy: "2026-10-22", outlook: later })).toEqual({ key: "orderSoon", reason: { kind: "orderBy", orderBy: "2026-10-22", lasts: "2026-12-01" } });
    expect(outcomeOf({ ...base, orderBy: "2026-10-23", outlook: later })).toEqual({ key: "ok", reason: { kind: "lasts", lasts: "2026-12-01", orderBy: "2026-10-23" } });
  });
  it("the rest: Too much, Learning, Don't reorder (first)", () => {
    expect(outcomeOf({ status: "too_much", today: TODAY, daysLeft: 210.6 })).toEqual({ key: "tooMuch", reason: { kind: "tooMuch", days: 210 } });
    expect(outcomeOf({ status: "not_enough_data", today: TODAY }).key).toBe("learning");
    expect(outcomeOf({ status: null, today: TODAY }).key).toBe("learning");
    expect(outcomeOf({ status: "out", today: TODAY, noReorder: true }).key).toBe("dontReorder");
  });
  it("no outlook (a row the plan can't project): the nightly status still gives a word", () => {
    expect(outcomeOf({ status: "running_low", today: TODAY }).key).toBe("orderSoon");
    expect(outcomeOf({ status: "running_low", today: TODAY, coverDays: 5, leadTimeDays: 14 }).key).toBe("orderNow");
    expect(outcomeOf({ status: "healthy", today: TODAY }).key).toBe("ok");
  });
  it("every word is translated, with a tone", () => {
    for (const k of ["orderNow", "orderSoon", "ok", "tooMuch", "notSelling", "learning", "dontReorder"] as const) {
      expect(outcomeLabel(k, (s) => translate("de", s))).not.toBe(outcomeLabel(k, id));
      expect(outcomeTone(k)).toBeTruthy();
    }
  });
});

describe("planOutcome and worstOutcome (an order in the plan; a supplier's orders)", () => {
  it("plans cached before the outlook: below safety stock is Order soon, a due-today date is never late", () => {
    expect(planOutcome({ orderBy: null, overdue: true, note: { runsOut: "2026-11-02", belowSafety: true } }, TODAY)).toEqual({ key: "orderSoon", reason: { kind: "buffer", lasts: "2026-11-02" } });
    expect(planOutcome({ orderBy: null, overdue: true, note: { soldOutSince: "2026-10-12" } }, TODAY).key).toBe("orderNow");
    expect(planOutcome({ orderBy: TODAY, overdue: true }, TODAY)).toEqual({ key: "orderSoon", reason: { kind: "orderBy", orderBy: TODAY, lasts: null } });
  });
  it("the most urgent word wins", () => {
    const soon: Outcome = { key: "orderSoon", reason: { kind: "buffer", lasts: null } };
    const now: Outcome = { key: "orderNow", reason: { kind: "soldOut", since: null } };
    expect(worstOutcome([soon, now, { key: "ok", reason: { kind: "none" } }])).toBe(now);
    expect(worstOutcome([])).toBeNull();
  });
});

describe("plain words for numbers", () => {
  it("pace: slow sellers in a readable unit, never '0.0 a day'", () => {
    expect([2.5, 12.4, 0.6, 0.05, 0.01, 0, null].map((r) => paceText(r, id, "en"))).toEqual([
      "2.5 a day",
      "12 a day",
      "about 4 a week",
      "about 2 a month",
      "less than 1 a month",
      "No recent sales",
      "—",
    ]);
  });
  it("the product page's answer: pace, how long it lasts, what to order and when", () => {
    const ctx = { t: id, locale: "en", today: TODAY, day, forecast: true };
    const outcome: Outcome = { key: "orderSoon", reason: { kind: "orderBy", orderBy: "2026-10-20", lasts: "2026-11-02" } };
    expect(verdictText({ rate: 0.03, onHand: 3, daysLeft: 99, orderBy: "2026-10-20", orderQty: 6, outcome }, ctx)).toBe(
      "Sells about 1 a month. 3 in stock, enough until about 2026-11-02. Order 6 by 2026-10-20.",
    );
    expect(verdictText({ rate: 2, onHand: 0, daysLeft: 0, orderBy: null, orderQty: 40, overdue: true }, ctx)).toBe("Sells 2 a day. Sold out now. Order 40 now.");
    expect(verdictText({ rate: 2, onHand: 9, daysLeft: 4, orderBy: null, orderQty: null }, { ...ctx, forecast: false })).toBe("Sells 2 a day. 9 in stock.");
    expect(verdictText({ rate: 2, onHand: 9, daysLeft: 4, orderBy: null, orderQty: null, noReorder: true }, ctx)).toBe("Left out of orders. It stays in your stock numbers.");
  });
  it("why this quantity, in a sentence whose numbers add up; rounding said only when it happened", () => {
    const why = { day: 0, days: 28, demand: 56, rate: 2, season: 1, growth: 1, safety: 10, onHand: 5, onOrder: 0, missed: 23, need: 38, rounded: 38, pack: null, moq: null, topUp: 0 };
    expect(whyPlain(why, id, "en")).toBe(
      "Sells 2 a day. The next 28 days need about 56, plus a buffer of 10. About 23 of those sales come before it can arrive, so they aren't ordered. You have 5 in stock, so order 38.",
    );
    expect(whyPlain({ ...why, day: 3, missed: 0, onOrder: 6, need: 55, rounded: 60, pack: 12 }, id, "en")).toBe(
      "Sells 2 a day. The next 28 days need about 56, plus a buffer of 10. You'll have about 5 in stock then and 6 on order, so order 60. Rounded up for the case pack or the supplier's minimum.",
    );
  });
});

describe("How we plan (said once per page)", () => {
  it("the store's own rules, locations only when some are left out", () => {
    expect(planBasisParts({ leadTimeDays: 21, cycleDays: 30, safetyLevel: "balanced", suppliers: 2, locationsLeftOut: 0 }, id, "en")).toEqual([
      "Sales counted only on days in stock",
      "21-day lead time unless a supplier has its own",
      "stock for 30 days after each delivery",
      "a standard buffer",
    ]);
    expect(planBasisParts({ leadTimeDays: 14, cycleDays: 30, safetyLevel: "lean", suppliers: 0, locationsLeftOut: 2 }, id, "en").slice(1)).toEqual([
      "14-day lead time",
      "stock for 30 days after each delivery",
      "a small buffer",
      "2 locations left out of orders",
    ]);
  });
});

describe("Dashboard actions: stock first", () => {
  it("reorder and sold-out rows lead, then clearance, promotions, page fixes; money order kept inside each", () => {
    const rows = [{ tab: "clear", n: 1 }, { tab: "fix", n: 2 }, { tab: "reorder", n: 3 }, { tab: "push", n: 4 }, { tab: "bridge", n: 5 }, { tab: "reorder", n: 6 }];
    expect(stockFirst(rows).map((r) => r.n)).toEqual([3, 5, 6, 1, 4, 2]);
  });
});

describe("first-session measurement", () => {
  it("shops per step and the median minutes from install", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 23, 10, m));
    const s = activationSummary([
      { shop: "a", kind: "installed", at: at(0) },
      { shop: "a", kind: "plan_seen", at: at(4) },
      { shop: "a", kind: "suggestions_seen", at: at(9) },
      { shop: "b", kind: "installed", at: at(0) },
      { shop: "b", kind: "plan_seen", at: at(10) },
      { shop: "c", kind: "first_po", at: at(1) }, // no install row (installed before measuring): counted, no time
    ]);
    expect(s.shops).toEqual({ installed: 2, plan_seen: 2, suggestions_seen: 1, first_po: 1 });
    expect(s.medianMinutesFromInstall).toEqual({ plan_seen: 7, suggestions_seen: 9, first_po: null });
  });
});
