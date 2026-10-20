/**
 * The action list generator (spec §7.7, tasks 2.1 + 2.4). Pure: engine results + facts in,
 * ActionDraft[] out (contract: app/lib/actions-shared.ts). One draft per (kind, product);
 * `variantIds` lists the affected variants; `amount` is in the store currency.
 *
 * Rules and their € figure (thresholds in ACTION_RULES):
 *  reorder     order-by date within 7 days or passed ("due this week" on the Order plan), Running
 *              low, or Out with demand (rate > 0); never "Don't reorder" → sales at risk (money-card maths)
 *  bridge      orderBy has passed, or the dated arrival is after the run-out day; and real demand
 *              (≥ 5 units in 28 d over those variants, or ≥ 50 sessions/week on the product page)
 *                                                                  → rate × seasonal × trend × gap × price
 *  push        A/B role, Healthy, the product's own sales vs the same 28 days last year ≥ 1 (else,
 *              without last year, trend ≥ 1); or Too much with landing conversion ≥ store
 *              median (≥ 200 sessions); never for a product with fix_falling
 *                                                                  → rate × 28 × price × 20 %
 *  fix_falling top 20 by revenue in the same 28 days last year; now ≤ 70 % of last year
 *                                                                  → revenue gap vs last year
 *  fix_sizes   ≥ 30 % of a product's variants (≥ 2) at 0 stock while it still sells (≥ 1 unit in 28 d)
 *                                                                  → estimated lost sales over 28 d
 *  fix_page    landing conversion < 0.5 × median of price peers (0.5×–2× its price, ≥ 5 peers,
 *              each and itself ≥ 200 sessions)                     → conversion gap × sessions × AOV
 *  fix_returns return rate ≥ max(25 %, 2 × store median), ≥ 10 units sold → value returned
 *  clear       Dead or Too much                                    → cash stuck (money-card maths)
 *
 * Arrival dates (bridge): the earliest expected arrival among the variant's open purchase orders
 * (sent | confirmed; confirmed ship date, else the lead-time estimate). A date already passed counts
 * as today (the order is late). `StockNow.incoming` WITHOUT a dated purchase order has no date: it
 * never triggers the "arrives after it runs out" rule, and when "order by" has passed the arrival is
 * estimated as today + lead time (an order placed today), shown as such in the facts.
 *
 * Missing data is never a 0: a variant without the inputs for its € figure is left out of the
 * figure; a draft is emitted only when at least one variant could be valued. Reorder, bridge and
 * clear figures may legitimately be 0 (measured); push / fix figures must be > 0.
 */
import { addDays, dayIndex, type DayKey } from "./dates-shared";
import { forecastRate } from "./order-shared";
import { atRiskUnits, round2, stuckUnits } from "./money-shared";
import type { Projection } from "./projection-shared";
import { ENGINE_DEFAULTS, type AbcRole, type EngineSettings, type VariantStatus } from "./types-shared";
import type { ActionDraft, ActionKind, ReasonParams } from "../actions-shared";

export const ACTION_RULES = Object.freeze({
  horizonDays: 28,
  /** Reorder fires when the order-by date is within this many days (today included), as "due this week". */
  reorderDueDays: 7,
  bridgeMinUnits28: 5,
  bridgeMinSessionsPerWeek: 50,
  pushShare: 0.2,
  minSessions: 200,
  fallingTop: 20,
  fallingMaxShare: 0.7,
  sizesMinShare: 0.3,
  sizesMinVariants: 2,
  pageMaxShareOfMedian: 0.5,
  pagePeerMinPrice: 0.5,
  pagePeerMaxPrice: 2,
  pageMinPeers: 5,
  returnsMinRate: 0.25,
  returnsMedianMultiple: 2,
  returnsMinUnits: 10,
});

export interface RuleVariant {
  id: string;
  status: VariantStatus;
  role: AbcRole;
  /** Sales per day while in stock; null = not enough data. */
  rate: number | null;
  seasonal: number;
  /** The APPLIED trend (1 when the growth assumption is off). */
  trend: number;
  /** The measured trend (season-shared TrendResult.measured), applied or not; null = unknown. */
  trendMeasured?: number | null;
  onHand: number;
  /** StockNow incoming (dated or not). */
  incoming: number;
  /** 0 when out; Infinity when the rate is 0; null when no advice. */
  daysLeft: number | null;
  orderBy: DayKey | null;
  orderQty: number | null;
  leadTimeDays: number;
  price: number | null;
  cost: number | null;
  /** Units sold over the last 28 days that have data (online pool); null = no data at all. */
  sold28: number | null;
  /** Days since the last sale (null = unknown). */
  noSaleDays: number | null;
  /** Earliest expected arrival of a dated open purchase order. */
  arrival: DayKey | null;
  /** Units on open purchase orders with a date (for the facts). */
  incomingDated?: number;
  /** The dated part of `incoming`, per arrival (sales at risk counts only what lands within 28 d). */
  incomingArrivals?: readonly { arrival: DayKey; units: number }[];
  /** Net units sold and units returned over the returns window (channel view); null = no data. */
  soldNet90?: number | null;
  returned90?: number | null;
  /** The day-by-day forecast behind sales at risk / cash stuck (computeVariant); absent = flat. */
  projection?: Projection | null;
  /** "Don't reorder" (Variant.noReorder): never in a reorder action. */
  noReorder?: boolean;
}

export interface RuleProduct {
  productId: string;
  /** All of the product's computed variants (active, tracked, not bundles). */
  variants: RuleVariant[];
  /** Landing sessions / sessions that checked out on /products/<handle>, last 28 d; null = no data. */
  sessions28: number | null;
  checkouts28: number | null;
  /** Gross revenue over the last 28 days and the same 28 days last year (null = not covered). */
  revenue28: number | null;
  revenue28LastYear: number | null;
}

export interface RuleContext {
  today: DayKey;
  settings?: EngineSettings;
  /** Store average order value (null = unknown: fix_page produces nothing). */
  aov: number | null;
  /** False while returns are not measured (all 0): fix_returns produces nothing. */
  returnsMeasured: boolean;
}

const known = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number) => Math.round(x * 1000) / 10;

export function median(xs: readonly number[]): number | null {
  const s = xs.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fRate(v: RuleVariant): number | null {
  return finite(v.rate) ? forecastRate(v.rate, { seasonal: v.seasonal, trend: v.trend }) : null;
}

/**
 * Same maths as the "sales at risk" card (money-shared atRiskUnits): forecast units the stock
 * can't serve over the next 28 days, projected day by day (dated incoming on its day, undated
 * after one lead time), × price.
 */
export function salesAtRiskOf(v: RuleVariant, today: DayKey): number | null {
  if (!finite(v.rate) || !known(v.price)) return null;
  const risk = atRiskUnits({ ...v, plan: 1 }, today, ACTION_RULES.horizonDays);
  return risk === null ? null : risk.units * v.price;
}

/** Same maths as the "cash stuck" card; retail price when cost is unknown. */
export function cashStuckOf(v: RuleVariant, settings: EngineSettings): { amount: number; retail: boolean; units: number } | null {
  const unit = known(v.cost) ? v.cost : known(v.price) ? v.price : null;
  if (unit === null) return null;
  let units: number;
  if (v.status === "dead") units = Math.max(0, v.onHand);
  else {
    const u = finite(v.rate) ? stuckUnits(v, settings.cashStuckCoverDays) : null;
    if (u === null) return null;
    units = u;
  }
  return { amount: unit * units, retail: !known(v.cost), units };
}

export function conversion(p: Pick<RuleProduct, "sessions28" | "checkouts28">): number | null {
  if (!finite(p.sessions28) || p.sessions28 < ACTION_RULES.minSessions || !finite(p.checkouts28)) return null;
  return Math.max(0, p.checkouts28) / p.sessions28;
}

function productPrice(p: RuleProduct): number | null {
  const ps = p.variants.map((v) => v.price).filter(known);
  return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
}

function draft(
  kind: ActionKind,
  productId: string,
  variantIds: string[],
  amount: number,
  key: string,
  params: ReasonParams,
  facts: Record<string, string | number | null>,
): ActionDraft {
  return { kind, productId, variantIds: [...variantIds].sort(), amount: round2(Math.max(0, amount)), reason: { key, params, facts } };
}

const DAY = (d: DayKey | null) => d ?? null;

// ── Reorder ────────────────────────────────────────────────────────────────

/**
 * Does this variant need a reorder action? (audit 2026-10-17, item 14) — the same set the Order
 * plan shows as "due this week": its stored order-by date (compute stores the forward plan's
 * date) is within the next 7 days (today + 6) or has passed; plus Running low, and Out with
 * demand. Never a "Don't reorder" variant, a Dead / not-enough-data one, or one without sales.
 */
export function reorderDue(v: RuleVariant, today: DayKey): boolean {
  if (v.noReorder) return false;
  if (!finite(v.rate) || !(v.rate > 0)) return false;
  if (v.status === "dead" || v.status === "not_enough_data") return false;
  if (v.status === "running_low" || v.status === "out") return true;
  return v.orderBy !== null && v.orderBy <= addDays(today, ACTION_RULES.reorderDueDays - 1);
}

function reorderRule(p: RuleProduct, ctx: RuleContext): ActionDraft | null {
  const hit = p.variants.filter((v) => reorderDue(v, ctx.today));
  const valued = hit.map((v) => ({ v, risk: salesAtRiskOf(v, ctx.today) })).filter((x) => x.risk !== null);
  if (!valued.length) return null;
  const amount = valued.reduce((a, x) => a + x.risk!, 0);
  const ids = hit.map((v) => v.id);
  const low = hit.filter((v) => v.status !== "out" && finite(v.daysLeft));
  const facts = (v: RuleVariant) => ({
    variants: hit.length,
    rate: finite(v.rate) ? r1(v.rate) : null,
    seasonal: v.seasonal,
    trend: v.trend,
    daysLeft: finite(v.daysLeft) ? r1(v.daysLeft) : null,
    leadTimeDays: v.leadTimeDays,
    orderBy: DAY(v.orderBy),
    orderQty: v.orderQty,
    onHand: v.onHand,
    incoming: v.incoming,
    price: v.price,
    horizonDays: ACTION_RULES.horizonDays,
  });
  if (low.length) {
    const v = low.reduce((a, b) => ((b.daysLeft as number) < (a.daysLeft as number) ? b : a));
    const orderBy = v.orderBy;
    const now = !orderBy || orderBy <= ctx.today;
    // Runs out before a new order could arrive, yet the order-by date is later: stock on order covers
    // the gap. Say so, instead of "takes 35 days to arrive. Order by Jan 3".
    const covered = !now && finite(v.leadTimeDays) && (v.daysLeft as number) < (v.leadTimeDays as number) && (v.incoming ?? 0) > 0;
    if (covered)
      return draft("reorder", p.productId, ids, amount, "reorder_next", { days: Math.max(0, Math.floor(v.daysLeft as number)), date: orderBy! }, facts(v));
    return draft(
      "reorder",
      p.productId,
      ids,
      amount,
      now ? "reorder_now" : "reorder_low",
      now
        ? { days: Math.max(0, Math.floor(v.daysLeft as number)), lead: v.leadTimeDays }
        : { days: Math.max(0, Math.floor(v.daysLeft as number)), lead: v.leadTimeDays, date: orderBy! },
      facts(v),
    );
  }
  const v = hit.reduce((a, b) => ((b.rate ?? 0) > (a.rate ?? 0) ? b : a));
  return draft("reorder", p.productId, ids, amount, "reorder_out", { rate: r1(v.rate as number) }, facts(v));
}

// ── Bridge ─────────────────────────────────────────────────────────────────

export interface BridgeGap {
  /** Fractional days between running out and the stock arriving (> 0). */
  gapDays: number;
  arrival: DayKey;
  arrivalSource: "purchase_order" | "lead_time";
  runsOut: number;
}

/** The gap for one variant, or null when no bridge is needed / possible. */
export function bridgeGap(v: RuleVariant, today: DayKey): BridgeGap | null {
  if (!finite(v.daysLeft) || !finite(v.rate) || v.rate <= 0) return null;
  const t = dayIndex(today);
  const orderByPassed = v.orderBy !== null && v.orderBy < today;
  let arrival: DayKey;
  let source: BridgeGap["arrivalSource"];
  if (v.arrival) {
    arrival = dayIndex(v.arrival) < t ? today : v.arrival;
    source = "purchase_order";
  } else if (orderByPassed || (v.daysLeft <= 0 && finite(v.incoming) && v.incoming > (finite(v.incomingDated) ? v.incomingDated : 0))) {
    // Out of stock now with stock on order but no date: the forward order plan assumes it lands
    // one lead time from today (its order-by date counts it), so the gap is bridged until then.
    arrival = addDays(today, Math.max(0, Math.round(v.leadTimeDays)));
    source = "lead_time";
  } else return null;
  const arrivesAfterRunOut = dayIndex(arrival) - t > v.daysLeft;
  if (!orderByPassed && !arrivesAfterRunOut) return null;
  const gapDays = dayIndex(arrival) - t - v.daysLeft;
  if (!(gapDays > 0)) return null;
  return { gapDays, arrival, arrivalSource: source, runsOut: v.daysLeft };
}

function bridgeRule(p: RuleProduct, ctx: RuleContext): ActionDraft | null {
  const gaps = p.variants.map((v) => ({ v, g: bridgeGap(v, ctx.today) })).filter((x) => x.g !== null);
  if (!gaps.length) return null;
  const units28 = gaps.reduce((a, x) => a + (finite(x.v.sold28) ? x.v.sold28 : 0), 0);
  const perWeek = finite(p.sessions28) ? p.sessions28 / 4 : null;
  const demandOk = units28 >= ACTION_RULES.bridgeMinUnits28 || (perWeek !== null && perWeek >= ACTION_RULES.bridgeMinSessionsPerWeek);
  if (!demandOk) return null;
  const valued = gaps.filter((x) => known(x.v.price));
  if (!valued.length) return null;
  const amount = valued.reduce((a, x) => a + (fRate(x.v) as number) * x.g!.gapDays * (x.v.price as number), 0);
  const worst = gaps.reduce((a, b) => (b.g!.gapDays > a.g!.gapDays ? b : a));
  const g = worst.g!;
  const out = worst.v.status === "out";
  return draft(
    "bridge",
    p.productId,
    gaps.map((x) => x.v.id),
    amount,
    out ? "bridge_out" : "bridge_gap",
    { gap: Math.max(1, Math.round(g.gapDays)), date: g.arrival },
    {
      variants: gaps.length,
      rate: r1(worst.v.rate as number),
      seasonal: worst.v.seasonal,
      trend: worst.v.trend,
      daysLeft: r1(g.runsOut),
      gapDays: r1(g.gapDays),
      arrival: g.arrival,
      arrivalSource: g.arrivalSource,
      orderBy: DAY(worst.v.orderBy),
      incoming: worst.v.incoming,
      incomingDated: worst.v.incomingDated ?? null,
      units28,
      sessionsPerWeek: perWeek === null ? null : r1(perWeek),
      price: worst.v.price,
    },
  );
}

// ── Push ───────────────────────────────────────────────────────────────────

/**
 * The product's own sales vs the same 28 days last year (fix_falling's windows and coverage
 * rule): revenue28 ÷ revenue28LastYear; null without last year's revenue (not covered, or none).
 */
export function productYoY(p: Pick<RuleProduct, "revenue28" | "revenue28LastYear">): number | null {
  if (!known(p.revenue28LastYear) || !finite(p.revenue28)) return null;
  return Math.max(0, p.revenue28) / p.revenue28LastYear;
}

/**
 * Push (review fix): "sales up or flat" is the PRODUCT's own year-on-year revenue (≥ 1) when last
 * year is known, so it can never contradict "falling best seller"; without last year's data it
 * falls back to the store / collection trend (≥ 1). generateActions never emits Push for a
 * product that gets fix_falling.
 */
function pushRule(p: RuleProduct, storeMedianConv: number | null): ActionDraft | null {
  const yoy = productYoY(p);
  // The trend here is a growth SIGNAL, not a forecast multiplier: the measured one, applied or not.
  const trendOf = (v: RuleVariant) => (finite(v.trendMeasured) ? v.trendMeasured : v.trend);
  const upOrFlat = (v: RuleVariant) => (yoy !== null ? yoy >= 1 : trendOf(v) >= 1);
  const strong = p.variants.filter((v) => (v.role === "A" || v.role === "B") && v.status === "healthy" && upOrFlat(v));
  const conv = conversion(p);
  const converts = conv !== null && storeMedianConv !== null && conv >= storeMedianConv;
  const tooMuch = converts ? p.variants.filter((v) => v.status === "too_much") : [];
  const hit = [...strong, ...tooMuch];
  const valued = hit.filter((v) => finite(v.rate) && known(v.price));
  const amount = valued.reduce((a, v) => a + (v.rate as number) * ACTION_RULES.horizonDays * (v.price as number) * ACTION_RULES.pushShare, 0);
  if (!(amount > 0)) return null;
  const facts = {
    variants: hit.length,
    trend: trendOf(hit[0]),
    ...(yoy === null ? {} : { revenue28: round2(Math.max(0, p.revenue28 as number)), revenue28LastYear: round2(p.revenue28LastYear as number) }),
    conversionPct: conv === null ? null : pct(conv),
    storeMedianPct: storeMedianConv === null ? null : pct(storeMedianConv),
    sessions28: p.sessions28,
    share: ACTION_RULES.pushShare,
    horizonDays: ACTION_RULES.horizonDays,
  };
  if (strong.length) {
    const tr = yoy ?? Math.max(...strong.map(trendOf));
    return Math.round((tr - 1) * 100) > 0
      ? draft("push", p.productId, hit.map((v) => v.id), amount, "push_up", { pct: Math.round((tr - 1) * 100) }, facts)
      : draft("push", p.productId, hit.map((v) => v.id), amount, "push_steady", {}, facts);
  }
  return draft("push", p.productId, hit.map((v) => v.id), amount, "push_converts", { conv: pct(conv!), median: pct(storeMedianConv!) }, facts);
}

// ── Fix · falling best seller ──────────────────────────────────────────────

function fallingRules(products: readonly RuleProduct[]): ActionDraft[] {
  const ranked = products
    .filter((p) => known(p.revenue28LastYear))
    .sort((a, b) => (b.revenue28LastYear as number) - (a.revenue28LastYear as number) || (a.productId < b.productId ? -1 : 1))
    .slice(0, ACTION_RULES.fallingTop);
  const out: ActionDraft[] = [];
  ranked.forEach((p, i) => {
    if (!finite(p.revenue28)) return;
    const ly = p.revenue28LastYear as number;
    const now = Math.max(0, p.revenue28);
    if (now > ACTION_RULES.fallingMaxShare * ly) return;
    out.push(
      draft("fix_falling", p.productId, p.variants.map((v) => v.id), ly - now, "fix_falling", { pct: Math.round((1 - now / ly) * 100) }, {
        revenue28: round2(now),
        revenue28LastYear: round2(ly),
        rankLastYear: i + 1,
        windowDays: ACTION_RULES.horizonDays,
      }),
    );
  });
  return out;
}

// ── Fix · missing sizes ────────────────────────────────────────────────────

function sizesRule(p: RuleProduct): ActionDraft | null {
  if (p.variants.length < ACTION_RULES.sizesMinVariants) return null;
  const zero = p.variants.filter((v) => v.onHand <= 0);
  if (zero.length / p.variants.length < ACTION_RULES.sizesMinShare) return null;
  const sold = p.variants.reduce((a, v) => a + (finite(v.sold28) ? Math.max(0, v.sold28) : 0), 0);
  if (!(sold >= 1)) return null;
  const rates = p.variants.map(fRate).filter((r): r is number => r !== null);
  const sibling = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
  const price = productPrice(p);
  let amount = 0;
  let valued = 0;
  let estimated = 0;
  for (const v of zero) {
    const own = fRate(v);
    const r = own ?? sibling;
    const pr = known(v.price) ? v.price : price;
    if (r === null || pr === null) continue;
    if (own === null) estimated++;
    amount += r * ACTION_RULES.horizonDays * pr;
    valued++;
  }
  if (!valued || !(amount > 0)) return null;
  return draft("fix_sizes", p.productId, zero.map((v) => v.id), amount, "fix_sizes", { out: zero.length, total: p.variants.length }, {
    soldOut: zero.length,
    variants: p.variants.length,
    units28: sold,
    estimatedFromSiblings: estimated,
    siblingRate: sibling === null ? null : r1(sibling),
    horizonDays: ACTION_RULES.horizonDays,
  });
}

// ── Fix · weak page ────────────────────────────────────────────────────────

function pageRules(products: readonly RuleProduct[], aov: number | null): ActionDraft[] {
  if (!known(aov)) return [];
  const rows = products
    .map((p) => ({ p, conv: conversion(p), price: productPrice(p) }))
    .filter((x) => x.conv !== null && x.price !== null);
  const out: ActionDraft[] = [];
  for (const x of rows) {
    const lo = x.price! * ACTION_RULES.pagePeerMinPrice;
    const hi = x.price! * ACTION_RULES.pagePeerMaxPrice;
    const peers = rows.filter((y) => y.p.productId !== x.p.productId && y.price! >= lo && y.price! <= hi);
    if (peers.length < ACTION_RULES.pageMinPeers) continue;
    const med = median(peers.map((y) => y.conv!));
    if (med === null || !(x.conv! < ACTION_RULES.pageMaxShareOfMedian * med)) continue;
    const amount = (med - x.conv!) * (x.p.sessions28 as number) * aov;
    if (!(amount > 0)) continue;
    out.push(
      draft("fix_page", x.p.productId, x.p.variants.map((v) => v.id), amount, "fix_page", { conv: pct(x.conv!), median: pct(med) }, {
        sessions28: x.p.sessions28,
        checkouts28: x.p.checkouts28,
        peers: peers.length,
        price: round2(x.price!),
        aov: round2(aov),
        windowDays: ACTION_RULES.horizonDays,
        basis: "landing sessions",
      }),
    );
  }
  return out;
}

// ── Fix · returns ──────────────────────────────────────────────────────────

function returnStats(p: RuleProduct): { units: number; returned: number; value: number | null } | null {
  let units = 0;
  let returned = 0;
  let value = 0;
  let priced = 0;
  let any = false;
  for (const v of p.variants) {
    if (!finite(v.soldNet90) && !finite(v.returned90)) continue;
    any = true;
    // quantity_returned's sign is not verified live: count it as a positive number of units.
    const r = finite(v.returned90) ? Math.abs(v.returned90) : 0;
    const net = finite(v.soldNet90) ? v.soldNet90 : 0;
    // net items sold = units sold − units returned, so units sold = net + returned.
    units += net + r;
    returned += r;
    if (r > 0 && known(v.price)) {
      value += r * v.price;
      priced++;
    }
  }
  return any ? { units, returned, value: priced ? value : null } : null;
}

function returnsRules(products: readonly RuleProduct[], measured: boolean): ActionDraft[] {
  if (!measured) return [];
  const rows = products
    .map((p) => ({ p, s: returnStats(p) }))
    .filter((x) => x.s !== null && x.s.units >= ACTION_RULES.returnsMinUnits);
  const med = median(rows.map((x) => x.s!.returned / x.s!.units));
  if (med === null) return [];
  const threshold = Math.max(ACTION_RULES.returnsMinRate, ACTION_RULES.returnsMedianMultiple * med);
  const out: ActionDraft[] = [];
  for (const x of rows) {
    const rate = x.s!.returned / x.s!.units;
    if (rate < threshold || x.s!.value === null || !(x.s!.value > 0)) continue;
    out.push(
      draft("fix_returns", x.p.productId, x.p.variants.filter((v) => finite(v.returned90) && v.returned90 !== 0).map((v) => v.id), x.s!.value, "fix_returns", { pct: Math.round(rate * 100), median: Math.round(med * 100) }, {
        unitsSold: x.s!.units,
        returned: x.s!.returned,
        thresholdPct: pct(threshold),
        windowDays: 90,
      }),
    );
  }
  return out;
}

// ── Clear ──────────────────────────────────────────────────────────────────

function clearRule(p: RuleProduct, settings: EngineSettings): ActionDraft | null {
  const hit = p.variants.filter((v) => v.status === "dead" || v.status === "too_much");
  const valued = hit.map((v) => ({ v, c: cashStuckOf(v, settings) })).filter((x) => x.c !== null);
  if (!valued.length) return null;
  const amount = valued.reduce((a, x) => a + x.c!.amount, 0);
  const units = valued.reduce((a, x) => a + x.c!.units, 0);
  const retail = valued.some((x) => x.c!.retail);
  const dead = hit.filter((v) => v.status === "dead");
  const facts = {
    variants: hit.length,
    dead: dead.length,
    tooMuch: hit.length - dead.length,
    units: Math.round(units),
    costBasis: retail ? "retail" : "cost",
    coverDays: settings.cashStuckCoverDays,
  };
  if (dead.length) {
    const days = Math.min(...dead.map((v) => (finite(v.noSaleDays) ? v.noSaleDays : settings.deadDays)));
    return draft("clear", p.productId, hit.map((v) => v.id), amount, "clear_dead", { days, units: Math.round(units) }, facts);
  }
  const left = hit.map((v) => v.daysLeft).filter((d): d is number => finite(d));
  return left.length
    ? draft("clear", p.productId, hit.map((v) => v.id), amount, "clear_too_much", { days: Math.round(Math.min(...left)) }, facts)
    : draft("clear", p.productId, hit.map((v) => v.id), amount, "clear_no_sales", {}, facts);
}

// ── Entry point ────────────────────────────────────────────────────────────

/** Every action for the shop. Order: by product, then ACTION_KINDS order (callers rank). */
export function generateActions(products: readonly RuleProduct[], ctx: RuleContext): ActionDraft[] {
  const settings = ctx.settings ?? ENGINE_DEFAULTS;
  const storeMedianConv = median(products.map(conversion).filter((c): c is number => c !== null));
  const falling = fallingRules(products);
  const fallingIds = new Set(falling.map((d) => d.productId));
  const out: ActionDraft[] = [];
  for (const p of products) {
    if (!p.variants.length) continue;
    const push = fallingIds.has(p.productId) ? null : pushRule(p, storeMedianConv);
    for (const d of [reorderRule(p, ctx), bridgeRule(p, ctx), push, sizesRule(p), clearRule(p, settings)]) {
      if (d) out.push(d);
    }
  }
  out.push(...falling, ...pageRules(products, ctx.aov), ...returnsRules(products, ctx.returnsMeasured));
  return out;
}

// ── Display helper ─────────────────────────────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Moved to lib/action-facts-shared (one formatter for Home, the Monday email and Slack). */
export { formatReasonParams } from "../action-facts-shared";
