/**
 * Cash (supplier module, Kanwar 2026-10-17): payment terms, landed cost, the cash per week and per
 * month, and the "Fit to budget" suggestion. Pure, client-safe; the database part is
 * models/order-plan.server.ts.
 *
 * Payment terms per supplier (Settings → Suppliers): a deposit (% of the goods) paid the day the
 * order is placed, the balance at one of three moments — the supplier's ship date (arrival − transit
 * days; the arrival when it has no transit), the arrival, or N days after the arrival. No terms =
 * everything is paid the day the order is placed (the behaviour before terms existed).
 *
 * Landed cost (freight + duty, % of the goods cost) is paid on arrival. It is in the cost lines and
 * the cash, shown separately; the purchase order documents to the supplier never include it (they
 * read the order's own lines).
 *
 * Two kinds of cash in the weeks and months:
 *  - "to plan": what the forward plan's orders (not placed yet) will cost, on the days it is paid;
 *  - "committed": what is still to pay on orders already sent / confirmed (their balance and
 *    freight). Their deposit was paid when they were sent; any other payment whose day has passed
 *    while the order is still open is due now (today).
 * Unknown costs are never 0: a line without a cost price has no payment and is counted.
 */
import { addDays, daysBetween, isoWeek, weekStart, type DayKey } from "./engine/dates-shared";
import type { PlanBatch, PlanEvent } from "./engine/forward-plan-shared";
import { fill } from "./i18n";

type T = (s: string) => string;

// ── Payment terms ───────────────────────────────────────────────────────────

export const BALANCE_DUE = ["ship", "arrival", "after_arrival"] as const;
export type BalanceDue = (typeof BALANCE_DUE)[number];

export const isBalanceDue = (v: unknown): v is BalanceDue => typeof v === "string" && (BALANCE_DUE as readonly string[]).includes(v);

/** A supplier's terms. `depositPct` 0–99 (100 % up front is no terms); `balanceDays` only for "after_arrival". */
export type PaymentTerms = { depositPct: number; balanceDue: BalanceDue; balanceDays: number };

/** Most days after arrival a balance may fall (Settings → Suppliers). */
export const BALANCE_DAYS_MAX = 365;
/** Highest landed cost (freight + duty) in % of the goods. */
export const LANDED_PCT_MAX = 500;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The stored columns (Supplier.depositPercent, balanceDue, balanceDays) as terms; null = everything
 * paid when ordering (no balance moment set, or a 100 % deposit).
 */
export function readPaymentTerms(row: { depositPercent?: number | null; balanceDue?: string | null; balanceDays?: number | null } | null | undefined): PaymentTerms | null {
  if (!row || !isBalanceDue(row.balanceDue)) return null;
  const dep = finite(row.depositPercent) ? Math.round(row.depositPercent) : 0;
  if (dep >= 100) return null;
  const days = row.balanceDue === "after_arrival" && finite(row.balanceDays) ? Math.min(BALANCE_DAYS_MAX, Math.max(0, Math.round(row.balanceDays))) : 0;
  return { depositPct: Math.max(0, dep), balanceDue: row.balanceDue, balanceDays: days };
}

/** Landed cost % (Supplier.landedCostPercent, Decimal → number); null when none. */
export function readLandedPct(v: unknown): number | null {
  const n = typeof v === "number" ? v : v !== null && v !== undefined ? Number(String(v)) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(LANDED_PCT_MAX, n) : null;
}

/** Freight + duty on a goods cost (store currency, 2 decimals); null when the cost or the % is unknown / none. */
export function landedOf(cost: number | null | undefined, pct: number | null | undefined): number | null {
  if (!finite(cost) || !finite(pct) || !(pct > 0)) return null;
  return round2((cost * pct) / 100);
}

// ── Payments of one order ───────────────────────────────────────────────────

/** "order" = the whole goods cost when ordering (no terms); "deposit" / "balance" with terms; "landed" = freight + duty. */
export type PaymentKind = "order" | "deposit" | "balance" | "landed";

export type Payment = { day: DayKey; amount: number; kind: PaymentKind };

export type OrderMoment = {
  /** The day the order is placed (planned) or was sent. */
  orderDay: DayKey;
  /** Expected arrival. */
  arrives: DayKey;
  /** The supplier's ship date when known (a confirmed one); else arrival − transit days. */
  shipDay?: DayKey | null;
  /** Days from the ship date to arrival (Supplier.transitDays); null / 0 = it ships on arrival. */
  transitDays?: number | null;
};

/** The supplier's ship date for an order: a confirmed one, else arrival − transit (never before the order). */
export function shipDayOf(m: OrderMoment): DayKey {
  if (m.shipDay) return m.shipDay;
  const transit = finite(m.transitDays) && m.transitDays > 0 ? Math.floor(m.transitDays) : 0;
  const ship = addDays(m.arrives, -transit);
  return ship < m.orderDay ? m.orderDay : ship;
}

/** The day the balance is paid under these terms. */
export function balanceDay(terms: PaymentTerms, m: OrderMoment): DayKey {
  if (terms.balanceDue === "ship") return shipDayOf(m);
  if (terms.balanceDue === "arrival") return m.arrives;
  return addDays(m.arrives, terms.balanceDays);
}

/**
 * The payments of one order: the goods (all on the order day without terms; deposit on the order
 * day + balance at its moment with terms; the two always add up to the goods cost) and the freight
 * + duty on arrival. A null goods cost gives no goods payment (unknown, never 0).
 */
export function orderPayments(m: OrderMoment, goods: number | null, landed: number | null, terms: PaymentTerms | null): Payment[] {
  const out: Payment[] = [];
  if (finite(goods) && goods > 0) {
    if (!terms) out.push({ day: m.orderDay, amount: round2(goods), kind: "order" });
    else {
      const deposit = round2((goods * terms.depositPct) / 100);
      const balance = round2(goods - deposit);
      if (deposit > 0) out.push({ day: m.orderDay, amount: deposit, kind: "deposit" });
      if (balance > 0) out.push({ day: balanceDay(terms, m), amount: balance, kind: "balance" });
    }
  }
  if (finite(landed) && landed > 0) out.push({ day: m.arrives, amount: round2(landed), kind: "landed" });
  return out;
}

/** What a supplier's money terms are, for one place to read them (the plan's supplier info). */
export type SupplierMoney = { terms: PaymentTerms | null; landedPct: number | null; transitDays: number | null };

/**
 * The plan's orders with their freight + duty (`landed`) and payments (`payments`), from each
 * supplier's terms. Events of a supplier without terms or landed cost keep one payment: their cost
 * on the order day — the cash per week before terms existed.
 */
export function withPayments<E extends Pick<PlanEvent, "supplierKey" | "orderBy" | "arrives" | "cost"> & { landed?: number | null; payments?: Payment[] }>(
  events: E[],
  money: Readonly<Record<string, SupplierMoney | undefined>>,
): E[] {
  for (const e of events) {
    const s = money[e.supplierKey];
    e.landed = landedOf(e.cost, s?.landedPct ?? null);
    e.payments = orderPayments({ orderDay: e.orderBy, arrives: e.arrives, transitDays: s?.transitDays ?? null }, e.cost, e.landed, s?.terms ?? null);
  }
  return events;
}

/** An event's payments (rows built before payments existed: the cost + freight on the order day). */
export function paymentsOf(e: Pick<PlanEvent, "orderBy" | "cost"> & { landed?: number | null; payments?: Payment[] }): Payment[] {
  if (e.payments) return e.payments;
  const amount = (finite(e.cost) ? e.cost : 0) + (finite(e.landed) ? e.landed : 0);
  return amount > 0 ? [{ day: e.orderBy, amount: round2(amount), kind: "order" }] : [];
}

// ── Open orders: what is still to pay ───────────────────────────────────────

/** A payment still due on an order already sent / confirmed. */
export type CommittedPayment = Payment & { supplierKey: string; po: string; number: string };

export type OpenOrderMoney = {
  id: string;
  number: string;
  supplierKey: string;
  /** Store-local day the order was sent. */
  sentDay: DayKey;
  /** Confirmed ship date (store-local day), if the supplier confirmed one. */
  shipDay: DayKey | null;
  /** Expected arrival (poArrival), else sent + lead time. */
  arrives: DayKey;
  /** Σ qty × unit cost (store currency); null when no line has a cost. */
  goods: number | null;
  money: SupplierMoney | null;
};

/**
 * Payments still due on an order already sent or confirmed: the balance and the freight + duty
 * (the deposit — or, without terms, the whole order — was paid when it was sent). A payment whose
 * day has passed while the order is still open is due today.
 */
export function openOrderPayments(o: OpenOrderMoney, today: DayKey): CommittedPayment[] {
  const landed = landedOf(o.goods, o.money?.landedPct ?? null);
  const all = orderPayments({ orderDay: o.sentDay, arrives: o.arrives, shipDay: o.shipDay, transitDays: o.money?.transitDays ?? null }, o.goods, landed, o.money?.terms ?? null);
  return all
    .filter((p) => p.kind === "balance" || p.kind === "landed")
    .map((p) => ({ ...p, day: p.day < today ? today : p.day, supplierKey: o.supplierKey, po: o.id, number: o.number }));
}

// ── Cash per week and per month ─────────────────────────────────────────────

export type CashWeek = {
  weekStart: DayKey;
  week: string;
  /** Paid for the plan's orders (not placed yet). */
  toPlan: number;
  /** Still due on orders already sent / confirmed. */
  committed: number;
  total: number;
  /** Of `total`: freight + duty. */
  landed: number;
};

export type PlannedPayments = readonly (Pick<PlanEvent, "orderBy" | "cost"> & { landed?: number | null; payments?: Payment[] })[];

/** Every ISO week from today's on (`weeks` of them; empty weeks included): the cash paid in it. */
export function cashWeeks(events: PlannedPayments, committed: readonly Payment[], today: DayKey, weeks: number): CashWeek[] {
  const first = weekStart(today);
  const out = new Map<DayKey, CashWeek>();
  for (let i = 0; i < weeks; i++) {
    const ws = addDays(first, i * 7);
    out.set(ws, { weekStart: ws, week: isoWeek(ws), toPlan: 0, committed: 0, total: 0, landed: 0 });
  }
  const add = (p: Payment, kind: "toPlan" | "committed") => {
    const w = out.get(weekStart(p.day < today ? today : p.day));
    if (!w) return;
    w[kind] = round2(w[kind] + p.amount);
    w.total = round2(w.total + p.amount);
    if (p.kind === "landed") w.landed = round2(w.landed + p.amount);
  };
  for (const e of events) for (const p of paymentsOf(e)) add(p, "toPlan");
  for (const p of committed) add(p, "committed");
  return [...out.values()];
}

export type CashSummary = {
  /** Paid in the weeks shown, for the plan's orders. */
  toPlan: number;
  /** Paid in the weeks shown, on orders already sent / confirmed. */
  committed: number;
  total: number;
  /** Of `total`: freight + duty. */
  landed: number;
  /** Paid after the last week shown (balances of late orders, freight on arrival). */
  later: number;
  /** Any payment known at all (else the totals are "—"). */
  any: boolean;
};

/** Totals of the weeks shown, and what is paid after them. */
export function cashSummary(events: PlannedPayments, committed: readonly Payment[], today: DayKey, weeks: number): CashSummary {
  const list = cashWeeks(events, committed, today, weeks);
  const end = addDays(weekStart(today), weeks * 7 - 1);
  let later = 0;
  let any = committed.length > 0;
  for (const e of events) {
    for (const p of paymentsOf(e)) {
      any = true;
      if (p.day > end) later += p.amount;
    }
  }
  for (const p of committed) if (p.day > end) later += p.amount;
  const sum = (k: "toPlan" | "committed" | "landed" | "total") => round2(list.reduce((a, w) => a + w[k], 0));
  return { toPlan: sum("toPlan"), committed: sum("committed"), total: sum("total"), landed: sum("landed"), later: round2(later), any };
}

export type CashMonth = {
  /** "2026-11". */
  month: string;
  /** First and last day of the month inside the window (today … end). */
  from: DayKey;
  to: DayKey;
  /** The window covers only part of the month. */
  partial: boolean;
  toPlan: number;
  committed: number;
  total: number;
};

const monthOf = (d: DayKey) => d.slice(0, 7);
/** First day of the month after `d`'s. */
export function nextMonthStart(d: DayKey): DayKey {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
const monthEnd = (d: DayKey) => addDays(nextMonthStart(d), -1);

/** Every calendar month touching today … end, with the cash paid in it (inside the window). */
export function cashMonths(events: PlannedPayments, committed: readonly Payment[], today: DayKey, end: DayKey): CashMonth[] {
  const out: CashMonth[] = [];
  for (let d = today; d <= end; d = nextMonthStart(d)) {
    const last = monthEnd(d);
    out.push({ month: monthOf(d), from: d, to: last > end ? end : last, partial: d !== `${monthOf(d)}-01` || last > end, toPlan: 0, committed: 0, total: 0 });
  }
  const byMonth = new Map(out.map((m) => [m.month, m]));
  const add = (p: Payment, kind: "toPlan" | "committed") => {
    const day = p.day < today ? today : p.day;
    if (day > end) return;
    const m = byMonth.get(monthOf(day));
    if (!m) return;
    m[kind] = round2(m[kind] + p.amount);
    m.total = round2(m.total + p.amount);
  };
  for (const e of events) for (const p of paymentsOf(e)) add(p, "toPlan");
  for (const p of committed) add(p, "committed");
  return out;
}

// ── Fit to budget (a suggestion only: nothing is changed) ───────────────────

/** The supplier minimums one order must keep (PlanSupplierInfo). */
export type FitRules = { minTotal: number | null; minValue: number | null; styleMin: number | null };

export type FitEvent = Pick<PlanEvent, "variantId" | "productId" | "supplierKey" | "orderBy" | "arrives" | "qty" | "cost" | "overdue"> & {
  landed?: number | null;
  payments?: Payment[];
};

export type FitInput = {
  today: DayKey;
  end: DayKey;
  /** Monthly budget, store currency. */
  budget: number;
  events: readonly FitEvent[];
  committed: readonly Payment[];
  /** Per variant: money at stake per day (forecast × price) and days of stock left. */
  variants: Readonly<Record<string, { valuePerDay: number | null; daysLeft: number | null; neverRunsOut?: boolean } | undefined>>;
  batches: readonly PlanBatch[];
  rules: Readonly<Record<string, FitRules | undefined>>;
};

export type Deferral = {
  variantId: string;
  productId: string;
  supplierKey: string;
  qty: number;
  /** Planned order day → suggested one (the supplier's next order next month, else the 1st). */
  from: DayKey;
  to: DayKey;
  /** Cash moved out of the month. */
  amount: number;
  /** Money at stake per day ÷ days until it runs out (lowest is deferred first). */
  priority: number;
  /** The whole supplier order of that week is deferred (its lines alone would break a minimum). */
  wholeOrder: boolean;
  /** Days it may be sold out before the deferred order arrives (0 = arrives in time; null unknown). */
  lateDays: number | null;
};

export type FitMonth = CashMonth & {
  budget: number;
  /** total − budget (> 0: over). */
  overBy: number;
  /** The month's cash with the deferrals. */
  after: number;
  /** Deferrals bring it within budget. */
  fits: boolean;
  deferrals: Deferral[];
};

/** Money at stake per day ÷ days until stock-out; null = can't be ranked (never suggested). */
export function deferPriority(v: { valuePerDay: number | null; daysLeft: number | null; neverRunsOut?: boolean } | undefined): number | null {
  if (!v || !finite(v.valuePerDay) || v.valuePerDay < 0) return null;
  const days = v.neverRunsOut ? 365 : finite(v.daysLeft) ? v.daysLeft : null;
  if (days === null) return null;
  return v.valuePerDay / Math.max(1, days);
}

const EPS = 0.005;

/**
 * The months over budget, each with the lowest-priority orders to defer to next month until it fits
 * (priority = money at stake per day ÷ days until stock-out). Minimums are never broken: a line is
 * deferred alone only when what stays in its supplier order still meets the supplier's minimums
 * (units, value, per style), and it joins that supplier's next order next month (or, without one,
 * meets the minimums by itself); otherwise the whole supplier order of that week is the candidate.
 * Overdue orders are never deferred, nor lines that can't be ranked. Months are handled in order;
 * what is deferred out of one month counts in the next. A suggestion: nothing is changed.
 */
export function fitToBudget(input: FitInput): FitMonth[] {
  const { today, end, budget } = input;
  if (!(budget > 0)) return [];
  // Each event's payments, shifted when deferred.
  type Ev = FitEvent & { i: number; pays: Payment[]; shift: number; deferred: boolean };
  const evs: Ev[] = input.events.map((e, i) => ({ ...e, i, pays: paymentsOf(e), shift: 0, deferred: false }));
  const batchOf = (e: FitEvent) => input.batches.findIndex((b) => b.supplierKey === e.supplierKey && e.orderBy >= b.from && e.orderBy <= b.to);
  const batchIdx = evs.map((e) => batchOf(e));
  const shifted = (e: Ev): Payment[] => (e.shift ? e.pays.map((p) => ({ ...p, day: addDays(p.day, e.shift) })) : e.pays);
  const months = () => cashMonths(evs.map((e) => ({ orderBy: e.orderBy, cost: e.cost, payments: shifted(e) })), input.committed, today, end);
  const inMonth = (p: Payment, m: CashMonth) => {
    const d = p.day < today ? today : p.day;
    return d >= m.from && d <= m.to;
  };
  const meets = (lines: readonly Ev[], rules: FitRules | undefined) => {
    if (!lines.length || !rules) return true;
    const units = lines.reduce((a, l) => a + l.qty, 0);
    if (rules.minTotal && units < rules.minTotal) return false;
    if (rules.minValue && lines.reduce((a, l) => a + (finite(l.cost) ? l.cost : 0), 0) < rules.minValue - EPS) return false;
    if (rules.styleMin) {
      const per = new Map<string, number>();
      for (const l of lines) per.set(l.productId, (per.get(l.productId) ?? 0) + l.qty);
      for (const q of per.values()) if (q < rules.styleMin) return false;
    }
    return true;
  };
  const out: FitMonth[] = [];
  const base = months();
  for (const m0 of base) {
    const m = months().find((x) => x.month === m0.month)!;
    if (!(m.total > budget + EPS)) continue;
    const next = nextMonthStart(m.from);
    // The supplier's first order day next month (its next batch), else the 1st of next month.
    const target = (key: string) => {
      const days = evs.filter((e) => !e.deferred && e.supplierKey === key && e.orderBy >= next).map((e) => e.orderBy).sort();
      return { day: days[0] ?? next, joins: days.length > 0 };
    };
    type Cand = { members: Ev[]; priority: number; whole: boolean };
    const cands: Cand[] = [];
    const live = evs.filter((e) => !e.deferred && e.orderBy >= m.from && e.orderBy <= m.to && e.pays.some((p) => inMonth(p, m)));
    const prio = (e: Ev) => (e.overdue ? null : deferPriority(input.variants[e.variantId]));
    for (const e of live) {
      const p = prio(e);
      if (p !== null) cands.push({ members: [e], priority: p, whole: false });
    }
    for (const b of new Set(live.map((e) => batchIdx[e.i]!).filter((x) => x >= 0))) {
      const members = evs.filter((e) => batchIdx[e.i] === b && !e.deferred);
      if (members.length < 2) continue;
      const ps = members.map(prio);
      if (ps.some((p) => p === null)) continue;
      cands.push({ members, priority: Math.max(...(ps as number[])), whole: true });
    }
    const amountIn = (c: Cand) => c.members.reduce((a, e) => a + e.pays.filter((p) => inMonth(p, m)).reduce((x, p) => x + p.amount, 0), 0);
    cands.sort((a, b) => a.priority - b.priority || Number(a.whole) - Number(b.whole) || amountIn(b) - amountIn(a) || a.members[0]!.i - b.members[0]!.i);
    let total = m.total;
    const deferrals: Deferral[] = [];
    for (const c of cands) {
      if (!(total > budget + EPS)) break;
      if (c.members.some((e) => e.deferred)) continue;
      const key = c.members[0]!.supplierKey;
      const rules = input.rules[key];
      const tgt = target(key);
      if (!c.whole) {
        const e = c.members[0]!;
        const b = batchIdx[e.i]!;
        const stays = b >= 0 ? evs.filter((x) => batchIdx[x.i] === b && !x.deferred && x !== e) : [];
        // What stays must still meet the minimums; the line joins next month's order or meets them alone.
        if (!meets(stays, rules)) continue;
        if (!tgt.joins && !meets([e], rules)) continue;
      }
      const amount = amountIn(c);
      if (!(amount > 0)) continue;
      for (const e of c.members) {
        e.shift = Math.max(0, daysBetween(e.orderBy, tgt.day));
        e.deferred = true;
        const v = input.variants[e.variantId];
        const runOut = v && !v.neverRunsOut && finite(v.daysLeft) ? addDays(today, Math.floor(v.daysLeft)) : null;
        const arrives = addDays(e.arrives, e.shift);
        deferrals.push({
          variantId: e.variantId,
          productId: e.productId,
          supplierKey: e.supplierKey,
          qty: e.qty,
          from: e.orderBy,
          to: tgt.day,
          amount: round2(e.pays.filter((p) => inMonth(p, m)).reduce((x, p) => x + p.amount, 0)),
          priority: prio(e) ?? c.priority,
          wholeOrder: c.whole,
          lateDays: runOut === null ? null : Math.max(0, daysBetween(runOut, arrives)),
        });
      }
      total = round2(total - amount);
    }
    const after = months().find((x) => x.month === m.month)!.total;
    out.push({ ...m, budget, overBy: round2(m.total - budget), after, fits: after <= budget + EPS, deferrals });
  }
  return out;
}

// ── Texts ───────────────────────────────────────────────────────────────────

/** "30% deposit, 70% at shipment" / "Paid on arrival" / "Paid when you order" (no terms). */
export function termsText(terms: PaymentTerms | null | undefined, t: T): string {
  if (!terms) return t("Paid when you order");
  const rest = 100 - terms.depositPct;
  const vars = { deposit: terms.depositPct, rest, n: terms.balanceDays };
  if (terms.depositPct <= 0) {
    if (terms.balanceDue === "ship") return t("Paid at shipment");
    if (terms.balanceDue === "arrival") return t("Paid on arrival");
    return fill(t("Paid {n} days after arrival"), vars);
  }
  if (terms.balanceDue === "ship") return fill(t("{deposit}% deposit, {rest}% at shipment"), vars);
  if (terms.balanceDue === "arrival") return fill(t("{deposit}% deposit, {rest}% on arrival"), vars);
  return fill(t("{deposit}% deposit, {rest}% {n} days after arrival"), vars);
}

/** "+ 12% freight & duty" (empty without a landed cost). */
export function landedText(pct: number | null | undefined, t: T, locale: string): string {
  if (!finite(pct) || !(pct > 0)) return "";
  let n: string;
  try {
    n = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(pct);
  } catch {
    n = String(pct);
  }
  return fill(t("+ {pct}% freight & duty"), { pct: n });
}

/**
 * The payments of one order as short phrases ("€300 deposit when you order", "€700 at shipment,
 * about 12 Dec", "€120 freight & duty on arrival, about 3 Jan"), in payment order.
 */
export function paymentPhrases(
  payments: readonly Payment[],
  terms: PaymentTerms | null | undefined,
  t: T,
  f: { money: (n: number) => string; day: (d: DayKey) => string },
): string[] {
  return [...payments]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((p) => {
      const vars = { amount: f.money(p.amount), date: f.day(p.day), n: terms?.balanceDays ?? 0 };
      if (p.kind === "order") return fill(t("{amount} when you order"), vars);
      if (p.kind === "deposit") return fill(t("{amount} deposit when you order"), vars);
      if (p.kind === "landed") return fill(t("{amount} freight & duty on arrival, about {date}"), vars);
      if (terms?.balanceDue === "ship") return fill(t("{amount} at shipment, about {date}"), vars);
      if (terms?.balanceDue === "after_arrival") return fill(t("{amount} {n} days after arrival, about {date}"), vars);
      return fill(t("{amount} on arrival, about {date}"), vars);
    });
}
