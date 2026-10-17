/**
 * Stored first / last days per variant (DB scale #3, audit 2026-10-17). Pure.
 *
 * Compute, per-location compute and the order plan used to scan a variant's whole history on
 * every run: `_min(day)` over StockDaily / SalesDaily per variant, and the last sale before the
 * 90-day window. The sync writes now keep those days up to date as they store facts:
 *
 *  - Variant.firstStockDay — first StockDaily row at any location;
 *  - Variant.firstSaleDay  — first SalesDaily row of the channel view (locationKey "all");
 *  - Variant.lastSaleDay   — last channel-view day with sold > 0;
 *  - VariantLocationDays (shop, variant, locationKey) — per location: firstStockDay (StockDaily
 *    at that Location.id) and lastSaleDay (location view, channel "all", that locationKey —
 *    "online", a Location.id or "pos:<name>"). Per-location compute, the pool (a subset of the
 *    locations) and pool demand without a left-out store need these; a Variant column cannot
 *    hold them.
 *
 * Meaning of null. VariantLocationDays is complete once the shop's days were built
 * (Shop.factDaysAt): a missing row or a null field means "none". The Variant columns are filled
 * lazily (compute reads the facts for variants whose column is null and stores the result), so
 * null there means "none or not known yet" — the sync never turns a null into a value (the
 * catalog may create a variant after its first facts were stored), it only moves known values.
 *
 * Merging a written range into a stored value (mergeFirst / mergeLast). `parts` are the day
 * ranges just REWRITTEN (deleted then inserted) and `chunk` the extreme day of the fresh rows:
 *  - first day, stored value inside a rewritten part: no older row exists (the stored value IS
 *    the oldest), so the new first is the chunk's first row — or, with none (or with days left
 *    unwritten between the parts), what the database now holds ("recompute": one lookup);
 *  - last day, stored inside a rewritten part: symmetric;
 *  - otherwise min / max of the stored value and the chunk's.
 * Days are `YYYY-MM-DD` strings (they compare as calendar days).
 */
import { addDays, type DayRange } from "./shopifyql-shared";
import type { SalesFact, StockFact } from "./facts-shared";
import { ALL } from "./facts-shared";

export const RECOMPUTE = "recompute" as const;
export type Merged = string | null | typeof RECOMPUTE;

const inParts = (day: string, parts: readonly DayRange[]) => parts.some((p) => day >= p.since && day <= p.until);

/** True when the parts, sorted, leave no day between them (their hull was all rewritten). */
export function partsContiguous(parts: readonly DayRange[]): boolean {
  const sorted = [...parts].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) if (addDays(sorted[i - 1].until, 1) < sorted[i].since) return false;
  return true;
}

/**
 * New first day after `parts` were rewritten. `stored` null = none stored: right for
 * VariantLocationDays; a null Variant column is "not known yet" and is never passed in (the
 * caller leaves it for compute's lazy fill).
 */
export function mergeFirst(stored: string | null, chunk: string | undefined, parts: readonly DayRange[]): Merged {
  // Inside a rewritten day: the oldest row may be gone. The chunk's first row is the answer only
  // when no day between the parts was left as it was (else a kept row could be older).
  if (stored !== null && inParts(stored, parts)) return chunk !== undefined && partsContiguous(parts) ? chunk : RECOMPUTE;
  if (chunk === undefined) return stored;
  return stored === null || chunk < stored ? chunk : stored;
}

/** New last day after `parts` were rewritten (null as in mergeFirst). */
export function mergeLast(stored: string | null, chunk: string | undefined, parts: readonly DayRange[]): Merged {
  if (stored !== null && inParts(stored, parts)) return chunk !== undefined && partsContiguous(parts) ? chunk : RECOMPUTE;
  if (chunk === undefined) return stored;
  return stored === null || chunk > stored ? chunk : stored;
}

/** Key of a VariantLocationDays row. */
export const locKey = (variantId: string, locationKey: string) => `${variantId}\u0000${locationKey}`;
export function splitLocKey(k: string): { variantId: string; locationKey: string } {
  const i = k.indexOf("\u0000");
  return { variantId: k.slice(0, i), locationKey: k.slice(i + 1) };
}

/** The extreme days of the facts written in one sync step (one dataset × range). */
export type DaysCollector = {
  /** Day ranges rewritten (deleted, then inserted), in write order. */
  parts: DayRange[];
  stock: {
    /** First stock row per variant (any location). */
    variantFirst: Map<string, string>;
    /** First stock row per variant × location. */
    locationFirst: Map<string, string>;
  } | null;
  sales: {
    /** First channel-view row per variant. */
    variantFirst: Map<string, string>;
    /** Last channel-view day with sold > 0 per variant. */
    variantLast: Map<string, string>;
    /** Last location-view day with sold > 0 per variant × locationKey. */
    locationLast: Map<string, string>;
  } | null;
};

export function newCollector(): DaysCollector {
  return { parts: [], stock: null, sales: null };
}

const keepMin = (m: Map<string, string>, k: string, day: string) => {
  const cur = m.get(k);
  if (cur === undefined || day < cur) m.set(k, day);
};
const keepMax = (m: Map<string, string>, k: string, day: string) => {
  const cur = m.get(k);
  if (cur === undefined || day > cur) m.set(k, day);
};

/** Records one written stock part (its facts and the days it rewrote). */
export function collectStock(c: DaysCollector, part: DayRange, facts: readonly StockFact[]): void {
  c.parts.push(part);
  const s = (c.stock ??= { variantFirst: new Map(), locationFirst: new Map() });
  for (const f of facts) {
    keepMin(s.variantFirst, f.variantId, f.day);
    keepMin(s.locationFirst, locKey(f.variantId, f.locationId), f.day);
  }
}

/** Records one written sales part: channel view (locationKey "all") and location view (channel "all"). */
export function collectSales(c: DaysCollector, part: DayRange, facts: readonly SalesFact[]): void {
  c.parts.push(part);
  const s = (c.sales ??= { variantFirst: new Map(), variantLast: new Map(), locationLast: new Map() });
  for (const f of facts) {
    if (f.locationKey === ALL) {
      keepMin(s.variantFirst, f.variantId, f.day);
      if (f.sold > 0) keepMax(s.variantLast, f.variantId, f.day);
    } else if (f.channel === ALL && f.sold > 0) {
      keepMax(s.locationLast, locKey(f.variantId, f.locationKey), f.day);
    }
  }
}

/** Every variant id the step wrote facts for. */
export function touchedVariants(c: DaysCollector): string[] {
  const ids = new Set<string>();
  for (const k of c.stock?.variantFirst.keys() ?? []) ids.add(k);
  for (const k of c.sales?.variantFirst.keys() ?? []) ids.add(k);
  for (const k of c.sales?.variantLast.keys() ?? []) ids.add(k);
  for (const k of c.sales?.locationLast.keys() ?? []) ids.add(splitLocKey(k).variantId);
  return [...ids];
}

/** The hull of the rewritten parts (stored days inside it may need a look at the database). */
export function partsHull(parts: readonly DayRange[]): DayRange | null {
  if (!parts.length) return null;
  let since = parts[0].since;
  let until = parts[0].until;
  for (const p of parts) {
    if (p.since < since) since = p.since;
    if (p.until > until) until = p.until;
  }
  return { since, until };
}

/**
 * The last sale BEFORE `from` (what compute's engine input means: the 90-day series covers the
 * rest) from the overall last sale `last`: known when there is none or it is older than `from`;
 * otherwise only the database can tell (undefined).
 */
export function lastSaleBefore(last: string | null | undefined, from: string): string | null | undefined {
  if (last === undefined) return undefined;
  if (last === null) return null;
  return last < from ? last : undefined;
}
