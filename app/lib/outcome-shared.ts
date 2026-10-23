/**
 * One status vocabulary for every screen (clarity pass, Kanwar 2026-10-23): what the merchant
 * should DO, in words a store owner reads in a second — never a stock-level word next to a number
 * that seems to contradict it (live 2026-10-23: "Overdue" beside 64 days of stock, "Low stock"
 * beside 99 days and 70 on order).
 *
 *   Order now   (red)    it is sold out, or it runs out before an order placed today could arrive
 *                        and its order is due (nothing on the way covers it)
 *   Order soon  (amber)  its order-by date is within a week or passed, but it lasts past a new
 *                        order's arrival — only the buffer is at stake; or it runs out until an
 *                        order already on the way arrives (ordering today wouldn't be sooner)
 *   OK          (green)  nothing to do this week
 *   Too much    (yellow) far more than it will sell before the next order
 *   Not selling (grey)   no sale for the dead-stock days while in stock
 *   Learning    (grey)   not enough days in stock with sales to plan yet
 *   Don't reorder        the merchant left it out of orders
 *
 * Each outcome carries its reason (`OutcomeReason`), shown under the badge, so the badge never
 * stands alone. Built from the forward plan's StockOutlook (engine/forward-plan-shared) when the
 * plan has it, else from the nightly status. Pure; the words are chosen in `outcomeText`.
 */
import type { DayKey } from "./engine/dates-shared";
import { addDays } from "./engine/dates-shared";
import type { StockOutlook } from "./engine/forward-plan-shared";
import type { VariantStatus } from "./engine/types-shared";

export const OUTCOMES = ["orderNow", "orderSoon", "ok", "tooMuch", "notSelling", "learning", "dontReorder"] as const;
export type OutcomeKey = (typeof OUTCOMES)[number];

/** The filter's choices (Products), in this order. */
export const OUTCOME_FILTERS: readonly OutcomeKey[] = ["orderNow", "orderSoon", "ok", "tooMuch", "notSelling", "learning"];

export function isOutcome(v: unknown): v is OutcomeKey {
  return typeof v === "string" && (OUTCOMES as readonly string[]).includes(v);
}

/** "Order soon": the order-by date falls within this many days (today included) — the plan's week. */
export const ORDER_SOON_DAYS = 7;

export type OutcomeReason =
  | { kind: "soldOut"; since: DayKey | null }
  | { kind: "runsOutFirst"; runsOut: DayKey | null; arrives: DayKey | null }
  | { kind: "waitsForOrder"; runsOut: DayKey | null }
  | { kind: "buffer"; lasts: DayKey | null }
  | { kind: "orderBy"; orderBy: DayKey; lasts: DayKey | null }
  | { kind: "lasts"; lasts: DayKey | null; orderBy: DayKey | null }
  | { kind: "tooMuch"; days: number | null }
  | { kind: "noSales" }
  | { kind: "learning" }
  | { kind: "dontReorder" }
  | { kind: "none" };

export type Outcome = { key: OutcomeKey; reason: OutcomeReason };

export type OutcomeInput = {
  /** The nightly status (VariantMetric.status); null = not computed yet. */
  status: VariantStatus | null;
  today: DayKey;
  noReorder?: boolean;
  /** The plan's order-by date for this variant (its next order, or the date that passed). */
  orderBy?: DayKey | null;
  /** Its order-by date has passed (forward plan). */
  overdue?: boolean;
  /** The forward plan's outlook; absent on rows the plan can't project. */
  outlook?: StockOutlook | null;
  /** Already out: the day it sold out (forward-plan dueNote), when known. */
  soldOutSince?: DayKey | null;
  /** On hand now (fallback when there is no outlook). */
  onHand?: number | null;
  /** Projected days the on-hand stock lasts (nightly), for "Too much" and the fallback. */
  daysLeft?: number | null;
  /** Cover with what is on order and the lead time (nightly inputs), for the fallback. */
  coverDays?: number | null;
  leadTimeDays?: number | null;
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function outcomeOf(i: OutcomeInput): Outcome {
  if (i.noReorder) return { key: "dontReorder", reason: { kind: "dontReorder" } };
  const o = i.outlook ?? null;
  const out = o ? o.outNow : i.status === "out" || (finite(i.onHand) && i.onHand <= 0 && i.status !== null);
  if (out && i.status !== "dead") return { key: "orderNow", reason: { kind: "soldOut", since: i.soldOutSince ?? null } };
  if (i.status === "not_enough_data") return { key: "learning", reason: { kind: "learning" } };
  if (i.status === "dead") return { key: "notSelling", reason: { kind: "noSales" } };
  if (i.status === null) return { key: "learning", reason: { kind: "none" } };
  const lasts = o?.runsOut ?? (finite(i.daysLeft) ? addDays(i.today, Math.max(0, Math.floor(i.daysLeft))) : null);
  // Runs out before an order placed today could arrive: sales are lost whatever happens now.
  const first = o
    ? o.beforeArrival && (!!i.overdue || !i.orderBy || i.orderBy <= i.today)
    : finite(i.coverDays) && finite(i.leadTimeDays) && i.status === "running_low" && i.coverDays < i.leadTimeDays;
  if (first) {
    const arrives = o?.arrives ?? (finite(i.leadTimeDays) ? addDays(i.today, Math.round(i.leadTimeDays)) : null);
    return { key: "orderNow", reason: { kind: "runsOutFirst", runsOut: lasts, arrives } };
  }
  // Runs out, but an order already on the way ends it and the next order isn't due yet.
  if (o?.beforeArrival) return { key: "orderSoon", reason: { kind: "waitsForOrder", runsOut: lasts } };
  const soon = addDays(i.today, ORDER_SOON_DAYS - 1);
  if (i.overdue || (i.orderBy && i.orderBy <= soon)) {
    return i.overdue || !i.orderBy || i.orderBy < i.today
      ? { key: "orderSoon", reason: { kind: "buffer", lasts } }
      : { key: "orderSoon", reason: { kind: "orderBy", orderBy: i.orderBy, lasts } };
  }
  // No outlook (a row the plan can't project): the nightly "running low" still means "order soon".
  if (!o && i.status === "running_low") return { key: "orderSoon", reason: { kind: "buffer", lasts } };
  if (i.status === "too_much") return { key: "tooMuch", reason: { kind: "tooMuch", days: finite(i.daysLeft) ? Math.floor(i.daysLeft) : null } };
  return { key: "ok", reason: { kind: "lasts", lasts, orderBy: i.orderBy ?? null } };
}

export type OutcomeTone = "critical" | "warning" | "success" | "caution" | "neutral" | "info";

export function outcomeTone(k: OutcomeKey): OutcomeTone {
  switch (k) {
    case "orderNow":
      return "critical";
    case "orderSoon":
      return "warning";
    case "ok":
      return "success";
    case "tooMuch":
      return "caution";
    case "learning":
      return "info";
    case "notSelling":
    case "dontReorder":
      return "neutral";
  }
}

type T = (s: string) => string;

export function outcomeLabel(k: OutcomeKey, t: T): string {
  switch (k) {
    case "orderNow":
      return t("Order now");
    case "orderSoon":
      return t("Order soon");
    case "ok":
      return t("OK");
    case "tooMuch":
      return t("Too much");
    case "notSelling":
      return t("Not selling");
    case "learning":
      return t("Learning");
    case "dontReorder":
      return t("Don't reorder");
  }
}

/** What each word means, in one line (the Dashboard's stock card, the filter, How it works). */
export function outcomeMeaning(k: OutcomeKey, t: T): string {
  switch (k) {
    case "orderNow":
      return t("Sold out, or runs out before a new order could arrive.");
    case "orderSoon":
      return t("Order within a week to keep its safety stock.");
    case "ok":
      return t("Enough stock. Nothing to do this week.");
    case "tooMuch":
      return t("Far more than it will sell before the next order.");
    case "notSelling":
      return t("No sale for a long time while in stock.");
    case "learning":
      return t("Not enough sales yet to plan it.");
    case "dontReorder":
      return t("You left it out of orders.");
  }
}

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? v[k]! : m));

/** The reason under the badge, e.g. "Runs out Nov 2 · a new order would arrive Nov 23". Empty when there is nothing to add. */
export function outcomeReasonText(r: OutcomeReason, t: T, day: (d: DayKey) => string): string {
  switch (r.kind) {
    case "soldOut":
      return r.since ? fill(t("Sold out since {date}"), { date: day(r.since) }) : t("Sold out");
    case "runsOutFirst":
      if (r.runsOut && r.arrives) return fill(t("Runs out {date} · a new order would arrive {arrives}"), { date: day(r.runsOut), arrives: day(r.arrives) });
      return r.arrives ? fill(t("Runs out before a new order could arrive ({arrives})"), { arrives: day(r.arrives) }) : t("Runs out before a new order could arrive");
    case "waitsForOrder":
      // No arrival date here: the plan's day for an open order can differ from the order's own
      // expected date (the order page has that); the words stay true either way.
      return r.runsOut ? fill(t("Runs out {date} until the stock on order arrives"), { date: day(r.runsOut) }) : t("Runs out before the stock on order arrives");
    case "buffer":
      return r.lasts ? fill(t("Lasts to {date} · dipping into safety stock"), { date: day(r.lasts) }) : t("Dipping into safety stock");
    case "orderBy":
      return r.lasts ? fill(t("Order by {date} · lasts to {lasts}"), { date: day(r.orderBy), lasts: day(r.lasts) }) : fill(t("Order by {date}"), { date: day(r.orderBy) });
    case "lasts":
      if (r.orderBy) return fill(t("Next order by {date}"), { date: day(r.orderBy) });
      return r.lasts ? fill(t("Lasts to {date}"), { date: day(r.lasts) }) : "";
    case "tooMuch":
      return r.days !== null ? fill(t("About {n} days of stock"), { n: String(r.days) }) : "";
    case "noSales":
      return t("No sale for a long time while in stock");
    case "learning":
      return t("Needs more days in stock with sales");
    case "dontReorder":
      return t("Left out of orders");
    case "none":
      return "";
  }
}

/**
 * Slow sellers in a readable unit (clarity pass: "0.0 a day" read as "never sells"):
 * 2.5 a day · about 4 a week · about 1 a month · less than 1 a month · no recent sales.
 */
export function paceText(rate: number | null | undefined, t: T, locale: string): string {
  if (!finite(rate)) return "—";
  if (rate <= 0) return t("No recent sales");
  const n = (v: number, digits = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(v);
  if (rate >= 1) return fill(t("{n} a day"), { n: n(rate, rate < 10 ? 1 : 0) });
  if (rate * 7 >= 1) return fill(t("about {n} a week"), { n: n(Math.round(rate * 7)) });
  if (Math.round(rate * 30) >= 1) return fill(t("about {n} a month"), { n: n(Math.round(rate * 30)) });
  return t("less than 1 a month");
}

/** A planned order's (or a plan line's) fields the status words need. */
export type PlanLineIn = {
  orderBy: DayKey | null;
  overdue: boolean;
  outlook?: StockOutlook | null;
  /** forward-plan dueNote / OverdueContext: soldOutSince, runsOut, belowSafety. */
  note?: { soldOutSince?: DayKey; runsOut?: DayKey; belowSafety?: boolean } | null;
};

/**
 * The words for an order in the plan (Due now, the Dashboard's suppliers, the calendar, the
 * builder): the variant is plannable, so only Order now / Order soon / OK apply. Plans cached
 * before the outlook existed fall back to the overdue context (below safety stock = Order soon).
 */
export function planOutcome(l: PlanLineIn, today: DayKey): Outcome {
  if (l.outlook) return outcomeOf({ status: "healthy", today, orderBy: l.orderBy, overdue: l.overdue, outlook: l.outlook, soldOutSince: l.note?.soldOutSince ?? null });
  // One label rule (2026-10-16): an order-by date of today is due today, never late — even with the flag.
  if (l.overdue && !(l.orderBy && l.orderBy >= today)) {
    if (l.note?.soldOutSince) return { key: "orderNow", reason: { kind: "soldOut", since: l.note.soldOutSince } };
    if (l.note?.belowSafety) return { key: "orderSoon", reason: { kind: "buffer", lasts: l.note.runsOut ?? null } };
    return { key: "orderNow", reason: { kind: "runsOutFirst", runsOut: l.note?.runsOut ?? null, arrives: null } };
  }
  return outcomeOf({ status: "healthy", today, orderBy: l.orderBy, overdue: false });
}

/** Most urgent first: the order of the Products table, the supplier's worst word, the Dashboard. */
export const OUTCOME_RANK: Record<OutcomeKey, number> = { orderNow: 0, orderSoon: 1, ok: 2, tooMuch: 3, notSelling: 4, learning: 5, dontReorder: 6 };

/** The most urgent outcome of several (a supplier's orders this week): Order now beats Order soon beats OK. */
export function worstOutcome(list: readonly Outcome[]): Outcome | null {
  let best: Outcome | null = null;
  for (const o of list) if (!best || OUTCOME_RANK[o.key] < OUTCOME_RANK[best.key]) best = o;
  return best;
}

/**
 * The product page's plain answer (clarity pass): "Sells about 1 a month. 3 in stock, enough
 * until about Dec 2. Order 1 by Oct 30." `forecast` false (Free): pace and stock only.
 */
export function verdictText(
  r: { rate: number | null; onHand: number | null; daysLeft: number | null; orderBy: DayKey | null; orderQty: number | null; overdue?: boolean; noReorder?: boolean; outcome?: Outcome },
  ctx: { t: T; locale: string; today: DayKey; day: (d: DayKey) => string; forecast: boolean },
): string {
  const { t, locale, today, day } = ctx;
  if (r.noReorder) return t("Left out of orders. It stays in your stock numbers.");
  const n = (v: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(v);
  const parts: string[] = [];
  if (finite(r.rate)) parts.push(r.rate > 0 ? fill(t("Sells {pace}."), { pace: paceText(r.rate, t, locale) }) : t("No recent sales."));
  if (finite(r.onHand)) {
    if (r.onHand <= 0) parts.push(t("Sold out now."));
    else {
      const reason = r.outcome?.reason;
      const lasts = reason && "lasts" in reason ? reason.lasts : reason?.kind === "runsOutFirst" || reason?.kind === "waitsForOrder" ? reason.runsOut : null;
      const until = lasts ?? (ctx.forecast && finite(r.daysLeft) ? addDays(today, Math.max(0, Math.floor(r.daysLeft))) : null);
      parts.push(ctx.forecast && until ? fill(t("{n} in stock, enough until about {date}."), { n: n(r.onHand), date: day(until) }) : fill(t("{n} in stock."), { n: n(r.onHand) }));
    }
  }
  if (ctx.forecast) {
    if (finite(r.orderQty) && r.orderQty > 0 && (r.overdue || !r.orderBy || r.orderBy <= today)) parts.push(fill(t("Order {qty} now."), { qty: n(r.orderQty) }));
    else if (finite(r.orderQty) && r.orderQty > 0 && r.orderBy) parts.push(fill(t("Order {qty} by {date}."), { qty: n(r.orderQty), date: day(r.orderBy) }));
    else if (r.orderBy) parts.push(fill(t("Next order by {date}."), { date: day(r.orderBy) }));
  }
  return parts.join(" ");
}
