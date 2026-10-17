/**
 * Forward order plan (Order plan · Next 90 days; Kanwar 2026-10-17). Pure.
 *
 * Per variant, a day-by-day projection from today with the nightly engine's own numbers (no new
 * data): what to order, when, and how much — and, for the whole store, the cash needed per week.
 *
 * Inputs are exactly what compute stored for the variant (VariantMetric + inputs):
 *  - daily demand c(d) = rate × trend × plan × S(d). S(d) is the seasonal index. When compute
 *    applied a seasonal index it also stored its weekly shape (`seasonCurve`, season-shared
 *    seasonCurve: last year's units/day per week ÷ the index's base, same store / collection
 *    source); the shape is clamped to 0.2–5 like the index and scaled so that its average over
 *    the order horizon H = lead time + cycle equals the stored seasonal index. So over the first
 *    H days the plan sells exactly what the nightly order quantity assumes, and later weeks
 *    follow last year's shape (a November ramp orders earlier and more). No curve → S = the
 *    stored index every day. Beyond the curve: the stored index.
 *  - safety stock (z × σ × √lead time), lead time (resolveLeadTime), cycle, on hand and incoming
 *    in the online pool. Incoming with a date (Shopify and Keha purchase orders, compute's
 *    landed estimate applied) arrives on that day (overdue → today); incoming without a date,
 *    and open Keha units compute did not count yet (drafts, orders sent since), arrive after
 *    one lead time.
 *  - the per-line rounding (lineQuantity: case pack, then MOQ) the Reorder screen uses.
 *
 * Rules:
 *  - Stock at arrival for an order placed on day s = projected stock at the start of day
 *    s + lead (other arrivals of that day included, the new order not). Projection is unclamped,
 *    as the nightly order-by date.
 *  - Order-by date (deadline) = the last day s with stock at arrival ≥ safety stock: waiting one
 *    more day would let it fall below. Already below today → the date it was (overdue), found by
 *    running today's demand backwards. With a flat forecast and nothing incoming this is the
 *    nightly formula today + ⌊daysLeft − lead − safety ÷ forecast rate⌋. Compute stores this as
 *    VariantMetric.orderBy (one number for Products, Order now and the calendar).
 *  - Day 0 (today) is a review day with the Reorder screen's own rule: an order today iff
 *    netNeed(orderNeed, notCounted) > 0, quantity lineQuantity(that need). orderNeed is
 *    demand(H) + safety − (on hand + incoming), the nightly orderQuantity semantics. So a
 *    variant has a day-0 order iff Order now lists it, with the same quantity (tested).
 *    It is flagged overdue when its order-by date has passed.
 *  - Later days: an order is placed on day t when ordering on day t + 1 would be too late
 *    (stock at arrival of a day-t+1 order < safety) and the need is positive:
 *        need(t) = demand[t, t + H) + safety − (projected stock(t) + everything still on order)
 *    quantity lineQuantity(need(t)); it arrives on t + lead and the projection continues, so a
 *    fast seller can need several orders in 13 weeks.
 *  - Dead, not-enough-data and no-sales variants get no orders (`skip` says why).
 */
import { addDays, daysBetween, isoWeek, toDayKey, weekStart, type DayKey } from "./dates-shared";
import { lineQuantity, netNeed, safetyStock } from "./order-shared";

/** Weeks in the calendar (the current ISO week + 12). */
export const PLAN_WEEKS = 13;
/** How far the order-by date is searched day by day before extrapolating. */
export const DEADLINE_SCAN_DAYS = 400;
/** Days of seasonal shape compute keeps beyond the horizon (≥ the calendar). */
export const FORWARD_CURVE_DAYS = 91;

const EPS = 1e-9;
const S_MIN = 0.2;
const S_MAX = 5;

export type PlanSkip = "dead" | "no_data" | "no_sales";

export interface ForwardVariantInput {
  today: DayKey;
  status: string;
  /** Sales per day while in stock (VariantMetric.rate). */
  rate: number | null;
  seasonal: number;
  trend: number;
  plan: number;
  /** Weekly seasonal shape (inputs.seasonCurve); null = flat at `seasonal`. */
  curve?: readonly (number | null)[] | null;
  /** Days from the curve's first day (the compute day) to today. */
  curveOffset?: number;
  safety: number | null;
  leadTimeDays: number;
  cycleDays: number;
  onHand: number;
  /** Everything on order (Shopify incoming + Keha units compute counted). */
  incoming: number;
  /** The dated part of `incoming`. */
  arrivals?: readonly { day: DayKey; units: number }[] | null;
  /** inputs.orderNeed: demand(H) + safety − (onHand + incoming); null = no advice. */
  need: number | null;
  /** VariantMetric.orderQty (fallback for rows computed before orderNeed). */
  orderQty?: number | null;
  /** Open Keha units compute did not count (drafts, orders sent since the run). */
  notCounted?: number;
  pack: number | null;
  moq: number | null;
  /** Orders are planned on days 0 … days − 1 (0 = only the order-by date). */
  days: number;
}

export interface ForwardOrder {
  /** Day offset from today the order is placed. */
  day: number;
  orderBy: DayKey;
  arrives: DayKey;
  qty: number;
  /** The unrounded need behind qty. */
  need: number;
  /** Day-0 order whose order-by date has passed. */
  overdue: boolean;
  /** The order-by date behind this order (= orderBy after day 0). */
  deadline: DayKey | null;
}

export interface ForwardVariantPlan {
  skip: PlanSkip | null;
  /** Order-by date (see the module header); null when the variant never runs low or has no advice. */
  deadline: DayKey | null;
  /** Today's need after open Keha orders (> 0 → on Order now); null when not plannable. */
  needNow: number | null;
  orders: ForwardOrder[];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Why a variant can't be planned (null = it can). */
export function planSkip(status: string, rate: number | null, need: number | null, orderQty?: number | null): PlanSkip | null {
  if (status === "dead") return "dead";
  if (status === "not_enough_data" || !finite(rate) || (need === null && !finite(orderQty))) return "no_data";
  if (rate <= 0) return "no_sales";
  return null;
}

/** Daily seasonal factor S(d) for d = 0 … len − 1 (see the module header). */
export function seasonalFactors(
  seasonal: number,
  curve: readonly (number | null)[] | null | undefined,
  horizonDays: number,
  len: number,
  /** Days between the curve's first day (compute's today) and day 0 (≥ 0). */
  offset = 0,
): number[] {
  const level = finite(seasonal) && seasonal > 0 ? seasonal : 1;
  const out = new Array<number>(len).fill(level);
  const known = (curve ?? []).filter((w): w is number => finite(w) && w >= 0);
  if (!curve || !known.length) return out;
  const fill = known.reduce((a, b) => a + b, 0) / known.length;
  const shift = Math.max(0, Math.floor(finite(offset) ? offset : 0));
  const span = curve.length * 7 - shift;
  if (span <= 0) return out;
  const raw = (d: number) => {
    const w = curve[Math.floor((d + shift) / 7)];
    return clamp(finite(w) ? w : fill, S_MIN, S_MAX);
  };
  const H = Math.max(1, Math.min(horizonDays, span));
  let sum = 0;
  for (let d = 0; d < H; d++) sum += raw(d);
  const k = sum > 0 ? (level * H) / sum : 1;
  for (let d = 0; d < Math.min(len, span); d++) out[d] = raw(d) * k;
  return out;
}

/** The forward plan for one variant (see the module header). */
export function planVariant(input: ForwardVariantInput): ForwardVariantPlan {
  const today = toDayKey(input.today);
  const skip = planSkip(input.status, input.rate, input.need, input.orderQty);
  const L = Math.max(0, Math.round(finite(input.leadTimeDays) ? input.leadTimeDays : 0));
  const C = Math.max(0, Math.round(finite(input.cycleDays) ? input.cycleDays : 0));
  const H = Math.max(1, L + C);
  const N = Math.max(0, Math.floor(input.days));
  const rate = finite(input.rate) ? input.rate : 0;
  const base = rate * (finite(input.trend) ? input.trend : 1) * (finite(input.plan) ? input.plan : 1);
  const safety = finite(input.safety) ? Math.max(0, input.safety) : null;
  const notCounted = Math.max(0, finite(input.notCounted) ? input.notCounted : 0);
  const needNow = skip ? null : netNeed(input.need, input.orderQty, notCounted);
  // Nothing to project with (no sales rate, or a row without safety stock): today's order
  // only, from the stored need, as Order now — no order-by date, no later orders.
  if (base <= 0 || safety === null) {
    const orders: ForwardOrder[] = [];
    const qty = needNow !== null && needNow > EPS && N > 0 ? lineQuantity(needNow, input.pack, input.moq) : 0;
    if (qty > 0) orders.push({ day: 0, orderBy: today, arrives: addDays(today, L), qty, need: needNow!, overdue: false, deadline: null });
    return { skip, deadline: null, needNow, orders };
  }

  // Demand per day and its prefix sums (P[d] = demand over days 0 … d − 1).
  const T = Math.max(N + H, DEADLINE_SCAN_DAYS + L + 2) + 1;
  const S = seasonalFactors(input.seasonal, input.curve, H, T, input.curveOffset ?? 0);
  const c = S.map((s) => base * s);
  const P = new Float64Array(T + 1);
  for (let d = 0; d < T; d++) P[d + 1] = P[d]! + c[d]!;

  // Arrivals: dated ones on their day (capped at the total incoming, earliest first), the rest
  // and the uncounted Keha units after one lead time.
  const arr = new Float64Array(T + 1);
  let left = Math.max(0, finite(input.incoming) ? input.incoming : 0);
  const dated = [...(input.arrivals ?? [])].filter((a) => finite(a.units) && a.units > 0).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  for (const a of dated) {
    const u = Math.min(a.units, left);
    if (u <= 0) break;
    const off = clamp(daysBetween(today, toDayKey(a.day)), 0, T);
    arr[off] += u;
    left -= u;
  }
  arr[Math.min(L, T)] += left + notCounted;

  // O[d] = projected stock at the start of day d (arrivals of day d included), unclamped.
  const O = new Float64Array(T + 1);
  O[0] = input.onHand + arr[0]!;
  for (let d = 0; d < T; d++) O[d + 1] = O[d]! - c[d]! + arr[d + 1]!;
  let onOrderTotal = arr.reduce((a, b) => a + b, 0);
  const safeAt = (s: number) => O[Math.min(T, s + L)]! >= safety - EPS;

  // Order-by date, before any planned order.
  let deadline: DayKey | null;
  if (!safeAt(0)) {
    deadline = addDays(today, Math.min(0, Math.floor((O[Math.min(T, L)]! - safety) / c[0]! + EPS)));
  } else {
    let found: number | null = null;
    for (let s = 0; s < DEADLINE_SCAN_DAYS; s++) {
      if (!safeAt(s + 1)) {
        found = s;
        break;
      }
    }
    if (found === null) {
      // Beyond the scan: the stored index, flat.
      const flat = base * (finite(input.seasonal) && input.seasonal > 0 ? input.seasonal : 1);
      const end = DEADLINE_SCAN_DAYS;
      found = end + Math.floor((O[Math.min(T, end + L)]! - safety) / flat + EPS);
    }
    deadline = addDays(today, found);
  }

  const orders: ForwardOrder[] = [];
  if (skip) return { skip, deadline, needNow: null, orders };

  const place = (t: number, need: number, overdue: boolean, dl: DayKey | null) => {
    const qty = lineQuantity(need, input.pack, input.moq);
    if (!(qty > 0)) return;
    const at = Math.min(T, t + L);
    for (let i = at; i <= T; i++) O[i] += qty;
    onOrderTotal += qty;
    orders.push({ day: t, orderBy: addDays(today, t), arrives: addDays(today, t + L), qty, need, overdue, deadline: dl });
  };

  // Day 0: the Reorder screen's rule.
  if (needNow === null) return { skip, deadline, needNow, orders };
  if (N > 0 && needNow > EPS) place(0, needNow, deadline !== null && deadline < today, deadline);

  // Later days: order when tomorrow would be too late.
  for (let t = 1; t < N; t++) {
    if (safeAt(t + 1)) continue;
    const position = input.onHand + onOrderTotal - P[t]!;
    const need = P[Math.min(T, t + H)]! - P[t]! + safety - position;
    if (need > EPS) place(t, need, false, addDays(today, t));
  }
  return { skip: null, deadline, needNow, orders };
}

// ---------------------------------------------------------------------------
// From a stored metric
// ---------------------------------------------------------------------------

/** VariantMetric row fields the forward plan reads. */
export interface StoredMetric {
  status: string;
  rate: number | null;
  sigma: number | null;
  orderQty: number | null;
  inputs: unknown;
}

const numIn = (o: Record<string, unknown>, k: string): number | null => (finite(o[k]) ? (o[k] as number) : null);

/**
 * ForwardVariantInput from a stored VariantMetric (online pool or a location). Rows written
 * before the forward plan existed (no safety / seasonCurve / arrivals in inputs) still plan:
 * safety from z × σ × √lead time, flat seasonality, undated incoming.
 */
export function forwardInputFromMetric(
  m: StoredMetric,
  x: { today: DayKey; pack: number | null; moq: number | null; notCounted: number; days: number },
): ForwardVariantInput {
  const inputs = m.inputs && typeof m.inputs === "object" ? (m.inputs as Record<string, unknown>) : {};
  const lead = numIn(inputs, "leadTimeDays") ?? 0;
  const z = numIn(inputs, "z");
  const safety = numIn(inputs, "safety") ?? (z !== null && finite(m.sigma) ? safetyStock(z, m.sigma, lead) : null);
  const rawCurve = Array.isArray(inputs.seasonCurve) ? (inputs.seasonCurve as unknown[]) : null;
  const rawArrivals = Array.isArray(inputs.arrivals) ? (inputs.arrivals as unknown[]) : [];
  const arrivals: { day: DayKey; units: number }[] = [];
  for (const a of rawArrivals) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    if (typeof r.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && finite(r.units)) arrivals.push({ day: r.day, units: r.units });
  }
  const computedOn = typeof inputs.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(inputs.today) ? inputs.today : null;
  return {
    today: x.today,
    curveOffset: computedOn ? Math.max(0, daysBetween(computedOn, toDayKey(x.today))) : 0,
    status: m.status,
    rate: m.rate,
    seasonal: numIn(inputs, "seasonal") ?? 1,
    trend: numIn(inputs, "trend") ?? 1,
    plan: numIn(inputs, "plan") ?? 1,
    curve: rawCurve ? rawCurve.map((v) => (finite(v) ? v : null)) : null,
    safety,
    leadTimeDays: lead,
    cycleDays: numIn(inputs, "cycleDays") ?? 0,
    onHand: numIn(inputs, "onHand") ?? 0,
    incoming: numIn(inputs, "incoming") ?? 0,
    arrivals,
    need: numIn(inputs, "orderNeed"),
    orderQty: m.orderQty,
    notCounted: x.notCounted,
    pack: x.pack,
    moq: x.moq,
    days: x.days,
  };
}

// ---------------------------------------------------------------------------
// Events, weeks, suppliers
// ---------------------------------------------------------------------------

export interface PlanEvent {
  variantId: string;
  productId: string;
  supplierKey: string;
  orderBy: DayKey;
  arrives: DayKey;
  qty: number;
  unitCost: number | null;
  /** qty × unitCost; null when the cost is unknown (never 0). */
  cost: number | null;
  overdue: boolean;
  /** The order-by date behind the order (overdue day-0 orders: in the past). */
  deadline: DayKey | null;
}

/** Last day of the calendar: the Sunday of the 13th ISO week starting with today's. */
export function planEnd(today: DayKey, weeks: number = PLAN_WEEKS): DayKey {
  return addDays(weekStart(today), weeks * 7 - 1);
}

/** Days from today through planEnd (orders are placed on days 0 … planDays − 1). */
export function planDays(today: DayKey, weeks: number = PLAN_WEEKS): number {
  return daysBetween(toDayKey(today), planEnd(today, weeks)) + 1;
}

export function eventsOf(
  plan: ForwardVariantPlan,
  v: { variantId: string; productId: string; supplierKey: string; unitCost: number | null },
): PlanEvent[] {
  const unit = finite(v.unitCost) && v.unitCost >= 0 ? v.unitCost : null;
  return plan.orders.map((o) => ({
    variantId: v.variantId,
    productId: v.productId,
    supplierKey: v.supplierKey,
    orderBy: o.orderBy,
    arrives: o.arrives,
    qty: o.qty,
    unitCost: unit,
    cost: unit === null ? null : Math.round(unit * o.qty * 100) / 100,
    overdue: o.overdue,
    deadline: o.deadline,
  }));
}

export interface CashTotals {
  units: number;
  /** Sum of the known costs; null when no line has a cost (shown as "—"). */
  cash: number | null;
  /** Lines without a cost price (not in `cash`). */
  missingCost: number;
  lines: number;
}

export function cashTotals(events: readonly Pick<PlanEvent, "qty" | "cost">[]): CashTotals {
  let units = 0;
  let cash = 0;
  let known = 0;
  let missing = 0;
  for (const e of events) {
    units += e.qty;
    if (e.cost === null) missing++;
    else {
      cash += e.cost;
      known++;
    }
  }
  return { units, cash: known > 0 ? Math.round(cash * 100) / 100 : null, missingCost: missing, lines: events.length };
}

export interface PlanSupplierWeek extends CashTotals {
  supplierKey: string;
  products: number;
  /** Earliest / latest order-by date of the lines (day-0 lines: today). */
  orderByFrom: DayKey;
  orderByTo: DayKey;
  overdue: boolean;
  events: PlanEvent[];
}

export interface PlanWeek extends CashTotals {
  weekStart: DayKey;
  week: string;
  suppliers: PlanSupplierWeek[];
  orderByFrom: DayKey | null;
  orderByTo: DayKey | null;
  overdue: boolean;
}

/** Events grouped by supplier, earliest order-by first (then key). */
export function bySupplier(events: readonly PlanEvent[]): PlanSupplierWeek[] {
  const m = new Map<string, PlanEvent[]>();
  for (const e of events) (m.get(e.supplierKey) ?? m.set(e.supplierKey, []).get(e.supplierKey)!).push(e);
  const out: PlanSupplierWeek[] = [];
  for (const [key, list] of m) {
    list.sort((a, b) => a.orderBy.localeCompare(b.orderBy) || (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0));
    out.push({
      supplierKey: key,
      ...cashTotals(list),
      products: new Set(list.map((e) => e.productId)).size,
      orderByFrom: list[0]!.orderBy,
      orderByTo: list[list.length - 1]!.orderBy,
      overdue: list.some((e) => e.overdue),
      events: list,
    });
  }
  return out.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.orderByFrom.localeCompare(b.orderByFrom) || (a.supplierKey < b.supplierKey ? -1 : 1));
}

/** The calendar: every ISO week from today's through planEnd (empty weeks included), by order-by date. */
export function byWeek(events: readonly PlanEvent[], today: DayKey, weeks: number = PLAN_WEEKS): PlanWeek[] {
  const first = weekStart(today);
  const buckets = new Map<DayKey, PlanEvent[]>();
  for (let i = 0; i < weeks; i++) buckets.set(addDays(first, i * 7), []);
  for (const e of events) buckets.get(weekStart(e.orderBy))?.push(e);
  return [...buckets].map(([ws, list]) => {
    const suppliers = bySupplier(list);
    const days = list.map((e) => e.orderBy).sort();
    return {
      weekStart: ws,
      week: isoWeek(ws),
      ...cashTotals(list),
      suppliers,
      orderByFrom: days[0] ?? null,
      orderByTo: days[days.length - 1] ?? null,
      overdue: list.some((e) => e.overdue),
    };
  });
}

/** Events placed within the next `days` days (today included; overdue day-0 orders too). */
export function dueWithin(events: readonly PlanEvent[], today: DayKey, days: number): PlanEvent[] {
  const last = addDays(today, days - 1);
  return events.filter((e) => e.orderBy <= last);
}
