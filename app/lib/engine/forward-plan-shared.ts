/**
 * Forward order plan (Order plan · Next 13 weeks; Kanwar 2026-10-17; ordering audit 2026-10-17). Pure.
 *
 * Per variant, a day-by-day projection from today with the nightly engine's own numbers (no new
 * data): what to order, when, and how much — and, for the whole store, the cash needed per week.
 * ONE rule for every screen (Dashboard "Order this week", Order now, Next 13 weeks, Products,
 * Sidekick, the Monday email): an order is placed ON its order-by date.
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
 *  - safety stock, lead time (resolveLeadTime), cycle, on hand and incoming in the stock pool.
 *    Incoming with a date (Shopify and Keha purchase orders, compute's landed estimate applied)
 *    arrives on that day (overdue → today); incoming without a date, and open Keha units compute
 *    did not count yet (fresh drafts, orders sent since), arrive after one lead time. Keha units
 *    closed short / cancelled / deleted since the run are taken out (withoutIncoming, H2).
 *  - the per-line rounding (lineQuantity: case pack, then MOQ).
 *
 * Rules:
 *  - Stock at arrival for an order placed on day s = projected stock at the start of day
 *    s + lead (other arrivals of that day included, the new order not).
 *  - Lost sales vs backorders (data audit 2026-10-17 #1). A variant that doesn't sell when out of
 *    stock (Shopify inventoryPolicy DENY, the default) LOSES the sales it misses: the projection
 *    is floored at 0 and the orders are sized as order-up-to minus the projected stock at arrival
 *    — the missed sales are not ordered back (`why.missed`). Before, the backlog was owed: 10/day,
 *    60-day lead, already out ordered 790 now + 140 every cycle, ~600 units too many for good.
 *    A variant that sells when out (CONTINUE), or whose available is already negative (evidence
 *    of backorders), keeps the unclamped projection: what it sells while out is owed.
 *  - Order-by date (deadline) = the last day s with stock at arrival ≥ safety stock: waiting one
 *    more day would let it fall below. Already below today → the date it was (overdue), found by
 *    running today's demand backwards while there is stock (at most lead time + the stock's
 *    days); already out or oversold → the day it ran out per sales history (`outSince`), else no
 *    date (M3: never one made up from a backlog). With a flat forecast and nothing incoming this is the
 *    nightly formula today + ⌊daysLeft − lead − safety ÷ forecast rate⌋. Compute stores it as
 *    VariantMetric.orderBy.
 *  - An order is placed on day t exactly when t is an order-by date: ordering on t + 1 would be
 *    too late (stock at arrival of a day-t+1 order < safety). Day 0 (today) included: an
 *    order-by date already passed is ordered today and flagged overdue. Never earlier — before
 *    the audit a variant was ordered "today" up to 14 days before its deadline, every day.
 *        need(t) = demand[t, t + H) + safety − (stock on hand at t + everything still on order)
 *                  − sales missed while sold out before it arrives (0 when it sells when out)
 *    quantity lineQuantity(need(t)); it arrives on t + lead and the projection continues, so a
 *    fast seller can need several orders in 13 weeks. `why` keeps the terms of that sum.
 *  - Supplier minimums (planStore): orders are batched per supplier — batch 0 = the next 7 days
 *    (what Order now and "Order this week" show), then every 7 days after. In each batch,
 *    after the per-line rounding: the minimum per style (minOrderScope "product": the product's
 *    total raised to the minimum, split across its variants by share of sales, largest
 *    remainder, whole case packs), then the order minimum in units, then the order minimum in
 *    money (store currency). Top-ups go into the projection, so later orders move out.
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
/** "Order now" / "Order this week": orders due in the next 7 days (today included, overdue too). */
export const ORDER_NOW_DAYS = 7;

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
  /** Open Keha units compute did not count (fresh drafts, orders sent since the run). */
  notCounted?: number;
  pack: number | null;
  moq: number | null;
  /** Orders are planned on days 0 … days − 1 (0 = only the order-by date). */
  days: number;
  /** M3: the day the current out-of-stock spell began (sales history; inputs.outSince); null unknown. */
  outSince?: DayKey | null;
  /**
   * Keeps selling when out of stock (Shopify inventoryPolicy CONTINUE): what it sells while out is
   * owed (a backlog). False / absent: missed sales are lost. A negative on hand counts as true.
   */
  sellsWhenOut?: boolean | null;
  /** Data audit #2: the pace comes from in-stock days since this day (inputs.pace.from); null = the usual windows. */
  paceFrom?: DayKey | null;
  /** R4: unusual days capped in the pace (inputs.spikes): how many, and the largest. */
  spikes?: SpikesWhy | null;
  /** R4: the style is planned like another product / its product type (inputs.planLike). */
  planLike?: PlanLikeWhy | null;
  /** B5: a sustained level change — the pace is the level since then (inputs.levelShift). */
  levelShift?: LevelShiftWhy | null;
  /** B4: what the safety stock covers (inputs.error). */
  safetyBasis?: SafetyBasisWhy | null;
}

/** Safety stock in the Why: the forecast's own error over `days` days and the fill target. */
export interface SafetyBasisWhy {
  days: number;
  error: number;
  fill: number;
}

/** A level shift in the Why: the first day at the new level and up (> 1) or down. */
export interface LevelShiftWhy {
  day: DayKey;
  ratio: number;
}

/** Unusual (spike) days capped in the pace: how many, and the largest one. */
export interface SpikesWhy {
  count: number;
  day: DayKey;
  sold: number;
  cap: number;
}

/** "Plan like…" in the Why: the reference, its %, and the style's own in-stock days so far. */
export interface PlanLikeWhy {
  kind: "product" | "productType";
  name: string;
  pct: number;
  days: number;
}

/**
 * Why an order has its quantity — the terms of need(t) as the plan computed them (shown in the
 * "Why this quantity" popover; never recomputed elsewhere).
 */
export interface OrderWhy {
  /** Days from today the order is placed (0 = today). */
  day: number;
  /** Days the order covers: lead time + cycle. */
  days: number;
  /** Forecast sales over those days. */
  demand: number;
  /** Sales per day while in stock (before season and growth). */
  rate: number;
  /** Average seasonal factor over those days. */
  season: number;
  /** Growth assumption (trend × plan); 1 = not applied. */
  growth: number;
  safety: number;
  /** Stock on hand when the order is placed (today: stock now; later: the projection). */
  onHand: number;
  /** Still on order then (arrives later). */
  onOrder: number;
  /** Sales missed while sold out before the order arrives (lost, not owed; 0 when it sells when out). */
  missed?: number;
  /** It keeps selling when out of stock: the backlog is owed and ordered back. */
  sellsWhenOut?: boolean;
  /** The sales pace comes from in-stock days since this day (out of stock most of the last 90 days). */
  paceFrom?: DayKey | null;
  /** Unusual days capped in the pace (R4). */
  spikes?: SpikesWhy | null;
  /** Planned like another product / its product type (R4). */
  planLike?: PlanLikeWhy | null;
  /** The pace is the level since a sustained change (B5). */
  levelShift?: LevelShiftWhy | null;
  /** What the safety stock covers (B4). */
  safetyBasis?: SafetyBasisWhy | null;
  /** demand + safety − onHand − onOrder − missed. */
  need: number;
  /** After the case pack and the per-variant minimum. */
  rounded: number;
  pack: number | null;
  moq: number | null;
  /** Units added to reach the supplier's minimums (per style, order units, order value). */
  topUp: number;
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
  /** The order-by date behind this order (= orderBy after day 0; day 0: today or the past date). */
  deadline: DayKey | null;
  /** The terms of the quantity; null for rows without the plan's inputs. */
  why: OrderWhy | null;
}

export interface ForwardVariantPlan {
  skip: PlanSkip | null;
  /** Order-by date (see the module header); null when the variant never runs low or has no advice. */
  deadline: DayKey | null;
  /** Today's stored need after open Keha orders; null when not plannable. */
  needNow: number | null;
  /** Already late today (see VariantProjection.overdue); with deadline null: out, run-out day unknown. */
  overdue: boolean;
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

// ---------------------------------------------------------------------------
// The projection of one variant (a small stateful simulator)
// ---------------------------------------------------------------------------

/**
 * One variant's projection. `nextOrderDay` finds the next order-by date from a day on;
 * `needAt` the need on a day with its terms; `add` books units arriving one lead time after
 * the day they are ordered (an order, or a top-up to it), so later dates move out.
 */
export class VariantProjection {
  readonly today: DayKey;
  readonly skip: PlanSkip | null;
  readonly needNow: number | null;
  readonly L: number;
  readonly H: number;
  readonly N: number;
  readonly pack: number | null;
  readonly moq: number | null;
  /** False: no sales rate or no safety stock (legacy rows) — only today's stored need. */
  readonly projected: boolean;
  /**
   * Order-by date before any planned order. null with `overdue`: already out of stock (or
   * oversold) and the day it ran out is unknown — no date is made up (M3).
   */
  readonly deadline: DayKey | null;
  /** Today's order is late: its stock at arrival is below safety stock. */
  readonly overdue: boolean;
  /** Sells when out of stock (input flag, or a negative on hand): the projection is not floored. */
  readonly sellsWhenOut: boolean;
  private readonly input: ForwardVariantInput;
  private readonly base: number;
  private readonly safety: number;
  private readonly T: number;
  private readonly c: number[] = [];
  private readonly S: number[] = [];
  private readonly P: Float64Array = new Float64Array(1);
  private readonly arr: Float64Array = new Float64Array(1);
  private readonly O: Float64Array = new Float64Array(1);
  /** Stock at the start of day d before the floor (negative: it ran out the day before). */
  private readonly U: Float64Array = new Float64Array(1);
  private onOrderTotal = 0;
  /** Legacy path: today's order was taken. */
  private legacyDone = false;

  constructor(input: ForwardVariantInput) {
    this.input = input;
    const today = toDayKey(input.today);
    this.today = today;
    this.skip = planSkip(input.status, input.rate, input.need, input.orderQty);
    this.L = Math.max(0, Math.round(finite(input.leadTimeDays) ? input.leadTimeDays : 0));
    const C = Math.max(0, Math.round(finite(input.cycleDays) ? input.cycleDays : 0));
    this.H = Math.max(1, this.L + C);
    this.N = Math.max(0, Math.floor(input.days));
    this.pack = input.pack;
    this.moq = input.moq;
    const rate = finite(input.rate) ? input.rate : 0;
    this.base = rate * (finite(input.trend) ? input.trend : 1) * (finite(input.plan) ? input.plan : 1);
    const safety = finite(input.safety) ? Math.max(0, input.safety) : null;
    this.safety = safety ?? 0;
    const notCounted = Math.max(0, finite(input.notCounted) ? input.notCounted : 0);
    this.needNow = this.skip ? null : netNeed(input.need, input.orderQty, notCounted);
    this.projected = this.base > 0 && safety !== null;
    this.sellsWhenOut = input.sellsWhenOut === true || (finite(input.onHand) && input.onHand < 0);
    this.T = 0;
    if (!this.projected) {
      this.deadline = null;
      this.overdue = false;
      return;
    }
    const L = this.L;
    const T = Math.max(this.N + this.H, DEADLINE_SCAN_DAYS + L + 2) + 1;
    this.T = T;
    this.S = seasonalFactors(input.seasonal, input.curve, this.H, T, input.curveOffset ?? 0);
    this.c = this.S.map((s) => this.base * s);
    this.P = new Float64Array(T + 1);
    for (let d = 0; d < T; d++) this.P[d + 1] = this.P[d]! + this.c[d]!;
    // Arrivals: dated ones on their day (capped at the total incoming, earliest first), the rest
    // and the uncounted Keha units after one lead time.
    this.arr = new Float64Array(T + 1);
    let left = Math.max(0, finite(input.incoming) ? input.incoming : 0);
    const dated = [...(input.arrivals ?? [])].filter((a) => finite(a.units) && a.units > 0).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    for (const a of dated) {
      const u = Math.min(a.units, left);
      if (u <= 0) break;
      const off = clamp(daysBetween(today, toDayKey(a.day)), 0, T);
      this.arr[off] += u;
      left -= u;
    }
    this.arr[Math.min(L, T)] += left + notCounted;
    // O[d] = projected stock at the start of day d (arrivals of day d included): floored at 0 when
    // missed sales are lost, unclamped when it sells when out. U[d] the same before the floor.
    this.O = new Float64Array(T + 1);
    this.U = new Float64Array(T + 1);
    this.project(0);
    this.onOrderTotal = this.arr.reduce((a, b) => a + b, 0);

    this.overdue = !this.safeAt(0);
    if (this.overdue) {
      if (this.O[0]! <= EPS) {
        // M3: already out (or oversold: a negative available is a backlog, not past sales).
        // Running today's demand backwards would invent a date (−200 units at 0.5/day = "428 days
        // ago"); the date is the day it ran out per sales history, else none.
        const out = input.outSince && /^\d{4}-\d{2}-\d{2}$/.test(input.outSince) && input.outSince < today ? input.outSince : null;
        this.deadline = out;
      } else {
        // Still in stock, below safety at arrival: the date it was, running today's demand back
        // over at most lead time + the days of stock left above safety (bounded: stock > 0). The
        // position at arrival is unclamped here: back then the stock was higher, nothing was missed.
        let atArrival = input.onHand - this.P[Math.min(T, L)]!;
        for (let i = 0; i <= Math.min(T, L); i++) atArrival += this.arr[i]!;
        this.deadline = addDays(today, Math.min(-1, Math.floor((atArrival - this.safety) / this.c[0]! + EPS)));
      }
    } else {
      let found: number | null = null;
      for (let s = 0; s < DEADLINE_SCAN_DAYS; s++) {
        if (!this.safeAt(s + 1)) {
          found = s;
          break;
        }
      }
      if (found === null) {
        // Beyond the scan: the stored index, flat.
        const flat = this.base * (finite(input.seasonal) && input.seasonal > 0 ? input.seasonal : 1);
        const end = DEADLINE_SCAN_DAYS;
        found = end + Math.floor((this.O[Math.min(T, end + L)]! - this.safety) / flat + EPS);
      }
      this.deadline = addDays(today, found);
    }
  }

  /** Can this variant get orders at all? */
  get plannable(): boolean {
    return this.skip === null && this.needNow !== null;
  }

  /** Recompute the projection from day `from` on (arrivals changed on that day). */
  private project(from: number): void {
    const { O, U, c, arr, T } = this;
    if (from <= 0) {
      O[0] = this.input.onHand + arr[0]!;
      U[0] = O[0]!;
      from = 0;
    }
    for (let d = from; d < T; d++) {
      const carry = O[d]! - c[d]!;
      U[d + 1] = carry + arr[d + 1]!;
      O[d + 1] = (this.sellsWhenOut ? carry : Math.max(0, carry)) + arr[d + 1]!;
    }
  }

  /** An order placed on day s arrives with at least safety stock and nothing ran out just before. */
  private safeAt(s: number): boolean {
    return this.U[Math.min(this.T, s + this.L)]! >= this.safety - EPS;
  }

  /** The next day d in [from, days) on which an order is due (an order-by date); null when none. */
  nextOrderDay(from: number): number | null {
    if (!this.plannable) return null;
    if (!this.projected) {
      // Legacy rows: today's stored need only, as Order now always did for them.
      return !this.legacyDone && from <= 0 && this.N > 0 && (this.needNow ?? 0) > EPS ? 0 : null;
    }
    for (let d = Math.max(0, from); d < this.N; d++) if (!this.safeAt(d + 1)) return d;
    return null;
  }

  /** The need for an order placed on day t, with its terms (the rounding is filled by the caller). */
  needAt(t: number): { need: number; why: OrderWhy | null } {
    if (!this.projected) return { need: this.needNow ?? 0, why: null };
    const T = this.T;
    const end = Math.min(T, t + this.H);
    const demand = this.P[end]! - this.P[t]!;
    let arrived = 0;
    for (let i = 0; i <= Math.min(t, T); i++) arrived += this.arr[i]!;
    // Today: stock now and everything on order (arrivals due today or overdue included); later:
    // the projected stock then (floored when missed sales are lost).
    const onHand = t === 0 ? this.input.onHand : this.O[Math.min(t, T)]!;
    const onOrder = t === 0 ? this.onOrderTotal : this.onOrderTotal - arrived;
    // Sales missed before the order lands: the floored stock at arrival minus the unclamped one.
    let missed = 0;
    if (!this.sellsWhenOut) {
      const a = Math.min(T, t + this.L);
      let unclamped = this.O[Math.min(t, T)]! - (this.P[a]! - this.P[Math.min(t, T)]!);
      for (let i = Math.min(t, T) + 1; i <= a; i++) unclamped += this.arr[i]!;
      missed = Math.max(0, this.O[a]! - unclamped);
      if (missed < 1e-7) missed = 0;
    }
    const need = demand + this.safety - onHand - onOrder - missed;
    let sSum = 0;
    for (let i = t; i < end; i++) sSum += this.S[i]!;
    const days = end - t;
    const growth = (finite(this.input.trend) ? this.input.trend : 1) * (finite(this.input.plan) ? this.input.plan : 1);
    return {
      need,
      why: {
        day: t,
        days,
        demand,
        rate: finite(this.input.rate) ? this.input.rate : 0,
        season: days > 0 ? sSum / days : 1,
        growth,
        safety: this.safety,
        onHand,
        onOrder,
        missed,
        sellsWhenOut: this.sellsWhenOut,
        paceFrom: this.input.paceFrom ?? null,
        spikes: this.input.spikes ?? null,
        planLike: this.input.planLike ?? null,
        levelShift: this.input.levelShift ?? null,
        safetyBasis: this.input.safetyBasis ?? null,
        need,
        rounded: 0,
        pack: this.pack,
        moq: this.moq,
        topUp: 0,
      },
    };
  }

  /** Book `qty` units ordered on day t (arriving t + lead). */
  add(t: number, qty: number): void {
    if (!(qty > 0)) return;
    if (!this.projected) {
      if (t === 0) this.legacyDone = true;
      return;
    }
    const at = Math.min(this.T, t + this.L);
    this.arr[at] += qty;
    if (at === 0) this.project(0);
    else this.project(at - 1);
    this.onOrderTotal += qty;
  }

  /** The order placed on day t for `qty` units (`need`, `why` from needAt). */
  order(t: number, qty: number, need: number, why: OrderWhy | null): ForwardOrder {
    const orderBy = addDays(this.today, t);
    const deadline = t === 0 ? (this.projected ? this.deadline : null) : orderBy;
    return {
      day: t,
      orderBy,
      arrives: addDays(this.today, t + this.L),
      qty,
      need,
      overdue: t === 0 && this.overdue,
      deadline,
      why,
    };
  }
}

/** The forward plan for one variant, without supplier minimums (see the module header). */
export function planVariant(input: ForwardVariantInput): ForwardVariantPlan {
  const sim = new VariantProjection(input);
  const orders: ForwardOrder[] = [];
  if (sim.skip) return { skip: sim.skip, deadline: sim.deadline, needNow: null, overdue: false, orders };
  let t = 0;
  for (let d = sim.nextOrderDay(t); d !== null; d = sim.nextOrderDay(t)) {
    const { need, why } = sim.needAt(d);
    const qty = lineQuantity(need, sim.pack, sim.moq);
    if (qty > 0) {
      sim.add(d, qty);
      orders.push(sim.order(d, qty, need, why ? { ...why, rounded: qty } : null));
    }
    t = d + 1;
  }
  return { skip: null, deadline: sim.deadline, needNow: sim.needNow, overdue: sim.overdue, orders };
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

/** inputs.spikes (R4) → the Why's count and largest capped day; null when none. */
export function spikesWhy(raw: unknown): SpikesWhy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const days = Array.isArray(r.days) ? r.days : [];
  let best: SpikesWhy | null = null;
  for (const d of days) {
    if (!d || typeof d !== "object") continue;
    const x = d as Record<string, unknown>;
    if (typeof x.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x.day) || !finite(x.sold) || !finite(x.cap)) continue;
    if (!best || x.sold > best.sold) best = { count: 0, day: x.day, sold: x.sold, cap: x.cap };
  }
  if (!best) return null;
  const count = finite(r.count) && r.count >= days.length ? r.count : days.length;
  return { ...best, count };
}

/** inputs.planLike (R4) → the Why's reference; null when not planned like another. */
function planLikeWhy(raw: unknown): PlanLikeWhy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if ((r.kind !== "product" && r.kind !== "productType") || typeof r.name !== "string" || !finite(r.pct)) return null;
  return { kind: r.kind, name: r.name, pct: r.pct, days: finite(r.ownDays) ? r.ownDays : 0 };
}

/** inputs.levelShift (B5) → the Why's day and direction; null when none. */
export function levelShiftWhy(raw: unknown): LevelShiftWhy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return typeof r.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && finite(r.ratio) ? { day: r.day, ratio: r.ratio } : null;
}

/** inputs.error (B4) → the Why's days, error and fill target; null when none. */
export function safetyBasisWhy(raw: unknown): SafetyBasisWhy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return finite(r.horizonDays) && finite(r.sigma) && finite(r.fill) ? { days: r.horizonDays, error: r.sigma, fill: r.fill } : null;
}

/** inputs.pace.from (data audit #2), or null. */
function paceFromInputs(p: unknown): DayKey | null {
  const from = p && typeof p === "object" ? (p as Record<string, unknown>).from : null;
  return typeof from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null;
}

/**
 * Take units out of the stored incoming (H2: Keha units closed short / cancelled / deleted since
 * the run). Each cut comes off its own arrival day first (`day`), then the latest arrivals, then
 * the undated part; never more than the incoming. Returns the new incoming, arrivals and the
 * units taken (the stored need grows by them).
 */
export function withoutIncoming(
  incoming: number,
  arrivals: readonly { day: DayKey; units: number }[],
  cuts: readonly { day: DayKey | null; units: number }[],
): { incoming: number; arrivals: { day: DayKey; units: number }[]; taken: number } {
  const list = arrivals.map((a) => ({ ...a }));
  const latest = [...list].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const total = Math.max(0, finite(incoming) ? incoming : 0);
  let taken = 0;
  for (const c of cuts) {
    let left = Math.min(Math.max(0, finite(c.units) ? c.units : 0), total - taken);
    taken += left;
    const take = (a: { units: number }) => {
      const u = Math.min(Math.max(0, a.units), left);
      a.units -= u;
      left -= u;
    };
    if (c.day) for (const a of list) if (left > 0 && a.day === c.day) take(a);
    for (const a of latest) if (left > 0) take(a);
    // Anything still left comes off the undated part (incoming − dated arrivals).
  }
  return { incoming: total - taken, arrivals: list.filter((a) => a.units > 0), taken };
}

/**
 * ForwardVariantInput from a stored VariantMetric (online pool or a location). Rows written
 * before the forward plan existed (no safety / seasonCurve / arrivals in inputs) still plan:
 * safety from z × σ × √(lead time + cycle), flat seasonality, undated incoming. `removed`: units on order
 * at the run that will no longer arrive (H2, lib/keha-since-run-shared): out of the incoming,
 * and the stored need grows by them.
 */
export function forwardInputFromMetric(
  m: StoredMetric,
  x: {
    today: DayKey;
    pack: number | null;
    moq: number | null;
    notCounted: number;
    days: number;
    removed?: readonly { day: DayKey | null; units: number }[];
  },
): ForwardVariantInput {
  const inputs = m.inputs && typeof m.inputs === "object" ? (m.inputs as Record<string, unknown>) : {};
  const lead = numIn(inputs, "leadTimeDays") ?? 0;
  const cycle = numIn(inputs, "cycleDays") ?? 0;
  const z = numIn(inputs, "z");
  // L3: rows saved before `safety` was stored protect lead time + cycle, as the engine and the
  // product page (products-shared readForecastInputs) do — not the lead time alone.
  const safety = numIn(inputs, "safety") ?? (z !== null && finite(m.sigma) ? safetyStock(z, m.sigma, lead + cycle) : null);
  const rawCurve = Array.isArray(inputs.seasonCurve) ? (inputs.seasonCurve as unknown[]) : null;
  const rawArrivals = Array.isArray(inputs.arrivals) ? (inputs.arrivals as unknown[]) : [];
  const arrivals: { day: DayKey; units: number }[] = [];
  for (const a of rawArrivals) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    if (typeof r.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && finite(r.units)) arrivals.push({ day: r.day, units: r.units });
  }
  const storedIncoming = numIn(inputs, "incoming") ?? 0;
  const cut = x.removed?.length ? withoutIncoming(storedIncoming, arrivals, x.removed) : null;
  const storedNeed = numIn(inputs, "orderNeed");
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
    cycleDays: cycle,
    onHand: numIn(inputs, "onHand") ?? 0,
    incoming: cut ? cut.incoming : storedIncoming,
    arrivals: cut ? cut.arrivals : arrivals,
    need: storedNeed === null ? null : storedNeed + (cut?.taken ?? 0),
    orderQty: cut?.taken && storedNeed === null && finite(m.orderQty) ? m.orderQty + cut.taken : m.orderQty,
    notCounted: x.notCounted,
    pack: x.pack,
    moq: x.moq,
    days: x.days,
    outSince: typeof inputs.outSince === "string" ? inputs.outSince : null,
    sellsWhenOut: inputs.sellsWhenOut === true,
    paceFrom: paceFromInputs(inputs.pace),
    spikes: spikesWhy(inputs.spikes),
    planLike: planLikeWhy(inputs.planLike),
    levelShift: levelShiftWhy(inputs.levelShift),
    safetyBasis: safetyBasisWhy(inputs.error),
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
  /** Unit cost in the store's currency (Shopify cost per item); null when unknown. */
  unitCost: number | null;
  /** qty × unitCost; null when the cost is unknown (never 0). */
  cost: number | null;
  overdue: boolean;
  /** The order-by date behind the order (overdue day-0 orders: in the past). */
  deadline: DayKey | null;
  /** The terms of the quantity (Why this quantity); null for rows without the plan's inputs. */
  why?: OrderWhy | null;
  /** Units sold in the same weeks last year (weekday-aligned, the `why.days` window); null unknown. */
  lastYear?: number | null;
  /**
   * Freight + duty on the line (supplier module: cost × the supplier's landed %; lib/cash-shared);
   * null / absent when the supplier has none or the cost is unknown. Never on the supplier's documents.
   */
  landed?: number | null;
  /** When the line's money is paid (lib/cash-shared withPayments); absent = its cost on the order day. */
  payments?: { day: DayKey; amount: number; kind: "order" | "deposit" | "balance" | "landed" }[];
}

/** Last day of the calendar: the Sunday of the 13th ISO week starting with today's. */
export function planEnd(today: DayKey, weeks: number = PLAN_WEEKS): DayKey {
  return addDays(weekStart(today), weeks * 7 - 1);
}

/** Days from today through planEnd (orders are placed on days 0 … planDays − 1). */
export function planDays(today: DayKey, weeks: number = PLAN_WEEKS): number {
  return daysBetween(toDayKey(today), planEnd(today, weeks)) + 1;
}

const costOf = (unit: number | null, qty: number) => (unit === null ? null : Math.round(unit * qty * 100) / 100);

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
    cost: costOf(unit, o.qty),
    overdue: o.overdue,
    deadline: o.deadline,
    why: o.why,
  }));
}

// ---------------------------------------------------------------------------
// Supplier minimums (pure; Order now, the Dashboard and the calendar share them)
// ---------------------------------------------------------------------------

const packOf = (pack: number | null | undefined) => (pack && pack > 1 ? Math.floor(pack) : 1);

export type TopUpLine = { qty: number; pack: number | null; weight: number };

/**
 * Raise the order total to `minTotal`: extra units go to the lines with a
 * quantity (> 0) in proportion to their weight (forecast sales per day; all
 * equal when no line has a weight), in whole case packs. Deterministic: bulk
 * whole-pack shares first, then one pack at a time to the line furthest below
 * its share (ties: the earlier line).
 */
export function topUpToMinimum(lines: readonly TopUpLine[], minTotal: number | null): { qtys: number[]; toppedUp: boolean } {
  const qtys = lines.map((l) => l.qty);
  const total = qtys.reduce((a, b) => a + b, 0);
  if (!minTotal || total >= minTotal) return { qtys, toppedUp: false };
  const eligible = lines.map((l, i) => ({ i, pack: packOf(l.pack), w: l.qty > 0 && l.weight > 0 && Number.isFinite(l.weight) ? l.weight : 0 })).filter((x) => lines[x.i]!.qty > 0);
  if (!eligible.length) return { qtys, toppedUp: false };
  const sumW = eligible.reduce((a, x) => a + x.w, 0);
  const share = (x: { w: number }) => (sumW > 0 ? x.w / sumW : 1 / eligible.length);
  const deficit = minTotal - total;
  const extra = new Map<number, number>();
  let added = 0;
  for (const x of eligible) {
    const bulk = Math.floor((deficit * share(x)) / x.pack) * x.pack;
    extra.set(x.i, bulk);
    added += bulk;
  }
  // Only lines with a share take more; with weights, a zero-weight line keeps its own quantity.
  const takers = eligible.filter((x) => share(x) > 0);
  while (total + added < minTotal) {
    let best = takers[0]!;
    let bestGap = -Infinity;
    for (const x of takers) {
      const gap = deficit * share(x) - (extra.get(x.i) ?? 0);
      if (gap > bestGap + 1e-9) {
        best = x;
        bestGap = gap;
      }
    }
    extra.set(best.i, (extra.get(best.i) ?? 0) + best.pack);
    added += best.pack;
  }
  for (const [i, e] of extra) qtys[i]! += e;
  return { qtys, toppedUp: added > 0 };
}

/**
 * Raise the order value (Σ qty × unitCost, store currency) to `minValue`, the same way as
 * topUpToMinimum: by weight, whole case packs, bulk first then one pack at a time to the line
 * furthest below its share of the missing value. Only lines with a quantity and a cost take
 * more; nothing happens when no line has a cost (the value is unknown).
 */
export function topUpToValue(
  lines: readonly (TopUpLine & { unitCost: number | null })[],
  minValue: number | null,
): { qtys: number[]; toppedUp: boolean } {
  const qtys = lines.map((l) => l.qty);
  if (!minValue || !(minValue > 0)) return { qtys, toppedUp: false };
  const value = lines.reduce((a, l) => a + (l.unitCost !== null && l.unitCost > 0 ? l.qty * l.unitCost : 0), 0);
  if (value >= minValue - 1e-9) return { qtys, toppedUp: false };
  const eligible = lines
    .map((l, i) => ({ i, pack: packOf(l.pack), cost: l.unitCost ?? 0, w: l.weight > 0 && Number.isFinite(l.weight) ? l.weight : 0 }))
    .filter((x) => lines[x.i]!.qty > 0 && x.cost > 0);
  if (!eligible.length) return { qtys, toppedUp: false };
  const sumW = eligible.reduce((a, x) => a + x.w, 0);
  const share = (x: { w: number }) => (sumW > 0 ? x.w / sumW : 1 / eligible.length);
  const takers = eligible.filter((x) => share(x) > 0);
  const deficit = minValue - value;
  const extra = new Map<number, number>();
  let added = 0;
  for (const x of takers) {
    const bulk = Math.floor((deficit * share(x)) / x.cost / x.pack) * x.pack;
    extra.set(x.i, bulk);
    added += bulk * x.cost;
  }
  while (value + added < minValue - 1e-9) {
    let best = takers[0]!;
    let bestGap = -Infinity;
    for (const x of takers) {
      const gap = deficit * share(x) - (extra.get(x.i) ?? 0) * x.cost;
      if (gap > bestGap + 1e-9) {
        best = x;
        bestGap = gap;
      }
    }
    extra.set(best.i, (extra.get(best.i) ?? 0) + best.pack);
    added += best.pack * best.cost;
  }
  let any = false;
  for (const [i, e] of extra) {
    if (e > 0) any = true;
    qtys[i]! += e;
  }
  return { qtys, toppedUp: any };
}

/**
 * Split `units` across items by weight (share of sales), in whole case packs, largest
 * remainder first (ties: the earlier item); all equal when no item has a weight. The result
 * adds up to at least `units` (whole packs can overshoot by less than one pack).
 */
export function splitByShare(units: number, items: readonly { weight: number; pack: number | null }[]): number[] {
  const out = items.map(() => 0);
  if (!(units > 0) || !items.length) return out;
  const w = items.map((x) => (x.weight > 0 && Number.isFinite(x.weight) ? x.weight : 0));
  const sumW = w.reduce((a, b) => a + b, 0);
  const share = (i: number) => (sumW > 0 ? w[i]! / sumW : 1 / items.length);
  let given = 0;
  items.forEach((x, i) => {
    const p = packOf(x.pack);
    out[i] = Math.floor((units * share(i)) / p) * p;
    given += out[i]!;
  });
  const takers = items.map((_, i) => i).filter((i) => share(i) > 0);
  while (given < units) {
    let best = takers[0]!;
    let bestGap = -Infinity;
    for (const i of takers) {
      const gap = units * share(i) - out[i]!;
      if (gap > bestGap + 1e-9) {
        best = i;
        bestGap = gap;
      }
    }
    const p = packOf(items[best]!.pack);
    out[best]! += p;
    given += p;
  }
  return out;
}

/** One variant of the store plan. */
export interface PlanVariantSpec {
  variantId: string;
  productId: string;
  supplierKey: string;
  /** Store-currency unit cost (Shopify cost per item); null when unknown. */
  unitCost: number | null;
  /** Share of sales for top-ups (forecast sales per day). */
  weight: number;
  input: ForwardVariantInput;
}

/** A supplier's order minimums. Per-variant MOQs are each input's `moq`. */
export interface PlanSupplierRules {
  /** minOrderScope "product": every product (style) in an order totals at least this. */
  styleMin: number | null;
  /** Units per order. */
  minTotal: number | null;
  /** Money per order, in the store's currency (converted from the supplier's); null = none / unknown. */
  minValue: number | null;
}

/** One supplier order the plan assumes: batch 0 = the next 7 days, then one every 7 days. */
export interface PlanBatch {
  supplierKey: string;
  from: DayKey;
  to: DayKey;
  /** Raised to the order minimum in units. */
  toppedUp: boolean;
  /** Raised to the order minimum in money. */
  valueToppedUp: boolean;
  /** Products raised to the minimum per style. */
  styleToppedUp: string[];
}

/** Day ranges [from, to] of the batches: the next 7 days (Order now), then every 7 days after. */
export function batchWindows(days: number): [number, number][] {
  const out: [number, number][] = [];
  for (let d = 0; d < days; d += ORDER_NOW_DAYS) out.push([d, Math.min(days, d + ORDER_NOW_DAYS) - 1]);
  return out;
}

export interface StorePlan {
  events: PlanEvent[];
  batches: PlanBatch[];
  /** Per variant: why it can't be planned, its order-by date before any order. */
  variants: Map<string, { skip: PlanSkip | null; deadline: DayKey | null; projected: boolean; overdue: boolean }>;
}

type Ev = { spec: number; day: number; qty: number; need: number; why: OrderWhy | null };

/**
 * The whole store's forward plan with the supplier minimums applied in each batch (see the
 * module header). Without minimums every variant's orders are exactly planVariant's.
 */
export function planStore(specs: readonly PlanVariantSpec[], rules: Readonly<Record<string, PlanSupplierRules>>, today: DayKey): StorePlan {
  const sims = specs.map((s) => new VariantProjection(s.input));
  const variants = new Map<string, { skip: PlanSkip | null; deadline: DayKey | null; projected: boolean; overdue: boolean }>();
  sims.forEach((sim, i) => variants.set(specs[i]!.variantId, { skip: sim.skip, deadline: sim.deadline, projected: sim.projected, overdue: sim.overdue }));
  const bySupplier = new Map<string, number[]>();
  specs.forEach((s, i) => (bySupplier.get(s.supplierKey) ?? bySupplier.set(s.supplierKey, []).get(s.supplierKey)!).push(i));
  const days = specs.reduce((a, s) => Math.max(a, Math.floor(s.input.days)), 0);
  const windows = batchWindows(days);
  const out: { spec: number; o: ForwardOrder }[] = [];
  const batches: PlanBatch[] = [];
  const keys = [...bySupplier.keys()].sort();
  for (const key of keys) {
    const members = bySupplier.get(key)!.slice().sort((a, b) => (specs[a]!.variantId < specs[b]!.variantId ? -1 : 1));
    const r = rules[key] ?? { styleMin: null, minTotal: null, minValue: null };
    for (const [a, b] of windows) {
      const evs: Ev[] = [];
      for (const i of members) {
        const sim = sims[i]!;
        let t = a;
        for (let d = sim.nextOrderDay(t); d !== null && d <= b; d = sim.nextOrderDay(t)) {
          const { need, why } = sim.needAt(d);
          const qty = lineQuantity(need, sim.pack, sim.moq);
          if (qty > 0) {
            sim.add(d, qty);
            evs.push({ spec: i, day: d, qty, need, why: why ? { ...why, rounded: qty } : null });
          }
          t = d + 1;
        }
      }
      if (!evs.length) continue;
      const batch: PlanBatch = { supplierKey: key, from: addDays(today, a), to: addDays(today, b), toppedUp: false, valueToppedUp: false, styleToppedUp: [] };
      const bump = (e: Ev, extra: number) => {
        if (!(extra > 0)) return;
        e.qty += extra;
        if (e.why) e.why = { ...e.why, topUp: e.why.topUp + extra };
        sims[e.spec]!.add(e.day, extra);
      };
      // Minimum per style: the product's total, split across its variants by share of sales.
      if (r.styleMin && r.styleMin > 0) {
        const products = [...new Set(evs.map((e) => specs[e.spec]!.productId))].sort();
        for (const pid of products) {
          const mine = evs.filter((e) => specs[e.spec]!.productId === pid);
          const total = mine.reduce((x, e) => x + e.qty, 0);
          if (total >= r.styleMin) continue;
          // Every plannable variant of the style from this supplier shares the minimum.
          const family = members.filter((i) => specs[i]!.productId === pid && sims[i]!.plannable);
          const withWeight = family.filter((i) => specs[i]!.weight > 0);
          const takers = withWeight.length ? withWeight : [...new Set(mine.map((e) => e.spec))];
          const split = splitByShare(r.styleMin - total, takers.map((i) => ({ weight: specs[i]!.weight, pack: sims[i]!.pack })));
          const day = Math.min(...mine.map((e) => e.day));
          takers.forEach((i, k) => {
            const extra = split[k]!;
            if (!(extra > 0)) return;
            let e = mine.find((x) => x.spec === i);
            if (!e) {
              const w = sims[i]!.needAt(day).why;
              e = { spec: i, day, qty: 0, need: 0, why: w ? { ...w, rounded: 0 } : null };
              evs.push(e);
            }
            bump(e, extra);
          });
          batch.styleToppedUp.push(pid);
        }
      }
      // Order minimum in units, then in money.
      const lines = () => evs.map((e) => ({ qty: e.qty, pack: sims[e.spec]!.pack, weight: specs[e.spec]!.weight, unitCost: unitOf(specs[e.spec]!) }));
      const units = topUpToMinimum(lines(), r.minTotal);
      units.qtys.forEach((q, k) => bump(evs[k]!, q - evs[k]!.qty));
      batch.toppedUp = units.toppedUp;
      const value = topUpToValue(lines(), r.minValue);
      value.qtys.forEach((q, k) => bump(evs[k]!, q - evs[k]!.qty));
      batch.valueToppedUp = value.toppedUp;
      batches.push(batch);
      for (const e of evs) out.push({ spec: e.spec, o: sims[e.spec]!.order(e.day, e.qty, e.need, e.why) });
    }
  }
  const events: PlanEvent[] = out.map(({ spec, o }) => {
    const s = specs[spec]!;
    const unit = unitOf(s);
    return {
      variantId: s.variantId,
      productId: s.productId,
      supplierKey: s.supplierKey,
      orderBy: o.orderBy,
      arrives: o.arrives,
      qty: o.qty,
      unitCost: unit,
      cost: costOf(unit, o.qty),
      overdue: o.overdue,
      deadline: o.deadline,
      why: o.why,
    };
  });
  events.sort((a, b) => a.orderBy.localeCompare(b.orderBy) || a.supplierKey.localeCompare(b.supplierKey) || (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0));
  return { events, batches, variants };
}

const unitOf = (s: Pick<PlanVariantSpec, "unitCost">) => (finite(s.unitCost) && s.unitCost >= 0 ? s.unitCost : null);

export interface CashTotals {
  units: number;
  /** Sum of the known costs, freight + duty included; null when no line has a cost (shown as "—"). */
  cash: number | null;
  /** Of `cash`: freight + duty (supplier landed cost); null when none. */
  landed?: number | null;
  /** Lines without a cost price (not in `cash`). */
  missingCost: number;
  lines: number;
}

export function cashTotals(events: readonly (Pick<PlanEvent, "qty" | "cost"> & { landed?: number | null })[]): CashTotals {
  let units = 0;
  let cash = 0;
  let landed = 0;
  let anyLanded = false;
  let known = 0;
  let missing = 0;
  for (const e of events) {
    units += e.qty;
    if (e.cost === null) missing++;
    else {
      cash += e.cost;
      known++;
      if (typeof e.landed === "number" && Number.isFinite(e.landed) && e.landed > 0) {
        cash += e.landed;
        landed += e.landed;
        anyLanded = true;
      }
    }
  }
  const out: CashTotals = { units, cash: known > 0 ? Math.round(cash * 100) / 100 : null, missingCost: missing, lines: events.length };
  if (anyLanded) out.landed = Math.round(landed * 100) / 100;
  return out;
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

/**
 * The day one order is due: its order-by date (`deadline`; an overdue order's is in the past) —
 * null when it is overdue and already out of stock with the day it ran out unknown ("Overdue"
 * without a date, M3). A day-0 order of a row the plan can't project keeps compute's date.
 */
export function dueDay(e: Pick<PlanEvent, "orderBy" | "overdue" | "deadline">): DayKey | null {
  return e.overdue ? e.deadline : (e.deadline ?? e.orderBy);
}

/** How an order-by date reads (one rule for every screen, the email and Sidekick). */
export type DueState = "overdue" | "today" | "upcoming";

/**
 * The label rule (sim check 2026-10-17): a date before today is overdue, today is "Due today" —
 * never overdue —, a later date is upcoming. Without a date: overdue when the order is late (already
 * out, run-out day unknown), else unknown (null). The flag never overrides a date of today or later.
 */
export function dueState(deadline: DayKey | null | undefined, today: DayKey, overdue = false): DueState | null {
  if (!deadline) return overdue ? "overdue" : null;
  if (deadline < today) return "overdue";
  return deadline === today ? "today" : "upcoming";
}

/**
 * M2: THE order-by date of a set of orders — a supplier's orders this week, one Order now line —
 * on every screen (Dashboard, Order now, Products, Sidekick, the Monday email): overdue when any
 * order is, and then the earliest date that passed (null when every overdue one is already out
 * with no known run-out day); otherwise the earliest order-by date.
 */
export function ordersDue(events: readonly Pick<PlanEvent, "orderBy" | "overdue" | "deadline">[]): { orderBy: DayKey | null; overdue: boolean } {
  const overdue = events.some((e) => e.overdue);
  const days = (overdue ? events.filter((e) => e.overdue) : events)
    .map(dueDay)
    .filter((d): d is DayKey => !!d)
    .sort();
  return { orderBy: days[0] ?? null, overdue };
}

/**
 * M4: one variant's orders as ONE line — Order now's line and Products' "To order": its orders
 * due in the next 7 days added together, at ordersDue's date (the earliest; overdue: the one that
 * passed); without one in the 7 days, its next planned order. `events`: that variant's, any order.
 */
export function variantLine(events: readonly PlanEvent[], today: DayKey): { qty: number; orderBy: DayKey | null; overdue: boolean; events: PlanEvent[] } | null {
  if (!events.length) return null;
  const sorted = [...events].sort((a, b) => a.orderBy.localeCompare(b.orderBy));
  const week = dueWithin(sorted, today, ORDER_NOW_DAYS);
  const used = week.length ? week : [sorted[0]!];
  return { qty: used.reduce((a, e) => a + e.qty, 0), ...ordersDue(used), events: used };
}

/** Events placed within the next `days` days (today included; overdue day-0 orders too). */
export function dueWithin(events: readonly PlanEvent[], today: DayKey, days: number): PlanEvent[] {
  const last = addDays(today, days - 1);
  return events.filter((e) => e.orderBy <= last);
}
