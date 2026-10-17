/**
 * Ordering maths (spec §7.4): ABC roles, safety stock, demand(H), days left,
 * order-by date and order quantity.
 */
import { addDays, type DayKey } from "./dates-shared";
import {
  ENGINE_DEFAULTS,
  type AbcRole,
  type EngineSettings,
  type ForecastMultipliers,
} from "./types-shared";

/** Float guard so 10.000000000001 does not ceil to 11. */
const EPS = 1e-9;

/**
 * ABC roles on 90-day revenue. Sorted by revenue desc, ties by id asc.
 * An item is A while the cumulative share BEFORE it is < abcAShare, B while
 * < abcBShare, else C. Zero, negative or non-finite revenue is always C.
 */
export function abcRoles(
  items: readonly { id: string; revenue90: number }[],
  settings: EngineSettings = ENGINE_DEFAULTS,
): Map<string, AbcRole> {
  const clean = items.map((it) => ({
    id: it.id,
    rev: Number.isFinite(it.revenue90) && it.revenue90 > 0 ? it.revenue90 : 0,
  }));
  const seen = new Set<string>();
  for (const it of clean) {
    if (seen.has(it.id)) throw new Error(`engine: duplicate id ${it.id} in abcRoles`);
    seen.add(it.id);
  }
  clean.sort((a, b) => b.rev - a.rev || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const total = clean.reduce((s, it) => s + it.rev, 0);
  const roles = new Map<string, AbcRole>();
  let cum = 0;
  for (const it of clean) {
    if (it.rev <= 0 || total <= 0) {
      roles.set(it.id, "C");
      continue;
    }
    const before = cum / total;
    roles.set(it.id, before < settings.abcAShare ? "A" : before < settings.abcBShare ? "B" : "C");
    cum += it.rev;
  }
  return roles;
}

export function zForRole(role: AbcRole, settings: EngineSettings = ENGINE_DEFAULTS): number {
  return settings.z[role];
}

/** rate × seasonal × trend (applied trend: 1 when the growth assumption is off). */
export function forecastRate(rate: number, m: Pick<ForecastMultipliers, "seasonal" | "trend">): number {
  return rate * m.seasonal * m.trend;
}

/**
 * demand(H) = rate × seasonal × trend × plan × H (spec §7.4).
 * `trend` is the APPLIED trend: 1 unless the shop turned the growth assumption on
 * (settings trendMode "store"; season-shared trendFactor). Audit 2026-10-17 (C4): today's pace
 * already contains the growth, so multiplying by the year-on-year trend again forecast +85 %
 * too high on a real store — the default is "off".
 */
export function demand(rate: number, m: ForecastMultipliers, horizonDays: number): number {
  return rate * m.seasonal * m.trend * m.plan * horizonDays;
}

/**
 * safety = z × σ_daily × √protectionDays. The engine passes lead time + order cycle (periodic
 * review, audit H4): between two orders the stock must cover uncertainty until the next order
 * arrives. σ_daily = daily demand σ on in-stock days without negative return days (rate-shared).
 */
export function safetyStock(z: number, sigma: number, protectionDays: number): number {
  return z * sigma * Math.sqrt(Math.max(0, protectionDays));
}

/** safetyDays = safety ÷ daily forecast (the engine passes rate × seasonal × trend); 0 when it is 0. */
export function safetyDays(safety: number, rate: number): number {
  return rate > 0 ? safety / rate : 0;
}

/** daysLeft = onHand ÷ forecastRate; 0 when onHand ≤ 0; Infinity when the rate is 0. */
export function daysLeft(onHand: number, fRate: number): number {
  if (onHand <= 0) return 0;
  if (fRate <= 0) return Infinity;
  return onHand / fRate;
}

/** orderBy = today + daysLeft − leadTime − safetyDays, floored; null when daysLeft is Infinity. */
export function orderByDate(
  today: DayKey,
  left: number,
  leadTimeDays: number,
  safetyD: number,
): DayKey | null {
  if (!Number.isFinite(left)) return null;
  return addDays(today, Math.floor(left - leadTimeDays - safetyD + EPS));
}

/** Supplier lead time when it is a finite number ≥ 0, else the shop default. */
export function resolveLeadTime(
  supplierDays: number | null | undefined,
  settings: EngineSettings = ENGINE_DEFAULTS,
): { days: number; source: "supplier" | "default" } {
  if (typeof supplierDays === "number" && Number.isFinite(supplierDays) && supplierDays >= 0) {
    return { days: supplierDays, source: "supplier" };
  }
  return { days: settings.leadTimeDays, source: "default" };
}

function roundUpTo(q: number, multiple: number): number {
  return Math.ceil(q / multiple) * multiple;
}

export interface OrderQtyInput {
  /** demand(leadTime + cycle). */
  demand: number;
  safety: number;
  onHand: number;
  incoming: number;
  caseQty?: number | null;
  minOrder?: number | null;
}

/**
 * orderQty = ceil(demand + safety − (onHand + incoming)), rounded UP to the
 * case pack, then raised to the minimum order (itself rounded up to the case
 * pack so the result stays a whole number of cases). Null when ≤ 0.
 */
export function orderQuantity(input: OrderQtyInput): number | null {
  const raw = Math.ceil(input.demand + input.safety - (input.onHand + input.incoming) - EPS);
  if (!(raw > 0)) return null;
  const pack = input.caseQty && input.caseQty > 1 ? Math.floor(input.caseQty) : 1;
  let q = roundUpTo(raw, pack);
  if (input.minOrder && input.minOrder > q) q = roundUpTo(input.minOrder, pack);
  return q;
}

const packOf = (pack: number | null | undefined) => (pack && pack > 1 ? Math.floor(pack) : 1);

/**
 * One order line's quantity (Order now, the forward plan, the planner): the need rounded up to
 * the case pack, then raised to the per-variant minimum (itself rounded up to the pack).
 * A need ≤ 0 stays 0.
 */
export function lineQuantity(need: number, pack: number | null, moq: number | null): number {
  if (!(need > 0)) return 0;
  const p = packOf(pack);
  let q = roundUpTo(Math.ceil(need - 1e-9), p);
  if (moq && moq > q) q = roundUpTo(moq, p);
  return q;
}

/**
 * Today's need after open Keha orders compute did not count yet (drafts, orders sent since the
 * last run): the unrounded need (VariantMetric.inputs.orderNeed) minus those units, never below
 * 0. Rows computed before orderNeed existed fall back to orderQty.
 */
export function netNeed(rawNeed: number | null | undefined, orderQty: number | null | undefined, notCounted: number): number {
  const extra = Math.max(0, Number.isFinite(notCounted) ? notCounted : 0);
  if (typeof rawNeed === "number" && Number.isFinite(rawNeed)) return Math.max(0, rawNeed - extra);
  return Math.max(0, (orderQty ?? 0) - extra);
}
