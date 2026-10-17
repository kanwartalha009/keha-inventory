/**
 * ShopifyQL rows → daily fact rows (spec §6.1, §8; task 1.4b). Pure.
 *
 * SalesDaily holds TWO views of the same sales, told apart by a sentinel (the 3-dimension
 * location × channel query was verified live on 2026-10-17 but is not used yet):
 *   - by location: locationKey = "online" | Location.id | "pos:<name>" (POS name with no
 *     matching Location), channel = ALL;   sold only (gross is not in that query → 0)
 *   - by channel:  locationKey = ALL, channel = sales_channel;   sold and gross
 * Never sum across the two views. Phase 1 compute reads the channel view (all channels =
 * the one online pool). TODO: switch to buildDailySalesQuery (3 dimensions, with
 * quantity_returned, verified) and drop the views — a data-model change compute must follow.
 *
 * Every builder drops rows outside the requested range (today is never stored, I-12).
 * Duplicates (audit 2026-10-17 M10): a row whose SOURCE identity (day, variant, raw location
 * name / channel / path) was already seen REPLACES the earlier one — overlapping pages can
 * never add stock or sales twice (the pager de-duplicates too; this is the second guard).
 * Only rows with DIFFERENT source identities that land on the same fact key (e.g. two location
 * names matching one Location) are added together. Re-running a month yields identical rows.
 */
import type { DayRange, SalesRow, SessionsRow, ShopDayRow, StockRow } from "./shopifyql-shared";

/** SalesDaily.locationKey for the channel view / SalesDaily.channel for the location view. */
export const ALL = "all";
export const ONLINE = "online";
export const UNMAPPED_POS_PREFIX = "pos:";

export type LocationRef = { id: string; name: string; active?: boolean };

/** Location name → id; exact match first, then trimmed case-insensitive. Active ones win ties. */
export function locationNameIndex(locations: LocationRef[]): (name: string) => string | undefined {
  const exact = new Map<string, string>();
  const loose = new Map<string, string>();
  const ordered = [...locations].sort((a, b) => Number(b.active !== false) - Number(a.active !== false));
  for (const l of ordered) {
    if (!exact.has(l.name)) exact.set(l.name, l.id);
    const k = l.name.trim().toLowerCase();
    if (!loose.has(k)) loose.set(k, l.id);
  }
  return (name) => exact.get(name) ?? loose.get(name.trim().toLowerCase());
}

const inRange = (day: string, r: DayRange) => day >= r.since && day <= r.until;

/** In-range rows, one per source identity; a later duplicate replaces the earlier one (upsert, never sum). */
export function latestByIdentity<T extends { day: string }>(rows: readonly T[], range: DayRange, identity: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) if (inRange(r.day, range)) m.set(identity(r), r);
  return [...m.values()];
}

const salesIdentity = (r: SalesRow) => `${r.day}|${r.variantId}|${r.locationKey}|${r.channel}`;

/** UTC midnight Date for a `@db.Date` column. */
export function dayDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export type SalesFact = { day: string; variantId: string; locationKey: string; channel: string; sold: number; returned: number; gross: number };
export type StockFact = { day: string; variantId: string; locationId: string; endUnits: number; outOfStock: boolean };
export type SessionsFact = { day: string; landingPath: string; trafficType: string; sessions: number; checkouts: number };
export type ShopFact = { day: string; orders: number; gross: number };

function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/** Location view of sales. POS names map to Location ids; null POS name = online. */
export function salesByLocationFacts(
  rows: SalesRow[],
  range: DayRange,
  locationId: (name: string) => string | undefined,
): { facts: SalesFact[]; unmapped: string[] } {
  const acc = new Map<string, SalesFact>();
  const unmapped = new Set<string>();
  for (const r of latestByIdentity(rows, range, salesIdentity)) {
    let key: string;
    if (r.locationKey === "online") key = ONLINE;
    else {
      const id = locationId(r.locationKey);
      if (id) key = id;
      else {
        unmapped.add(r.locationKey);
        key = UNMAPPED_POS_PREFIX + r.locationKey;
      }
    }
    const k = `${r.day}|${r.variantId}|${key}`;
    const f = acc.get(k) ?? { day: r.day, variantId: r.variantId, locationKey: key, channel: ALL, sold: 0, returned: 0, gross: 0 };
    f.sold += r.sold;
    f.returned += r.returned;
    acc.set(k, f);
  }
  return { facts: [...acc.values()].map((f) => ({ ...f, sold: Math.round(f.sold), returned: Math.round(f.returned) })), unmapped: [...unmapped] };
}

/** Channel view of sales (sold + gross). */
export function salesByChannelFacts(rows: SalesRow[], range: DayRange): SalesFact[] {
  const acc = new Map<string, SalesFact>();
  for (const r of latestByIdentity(rows, range, salesIdentity)) {
    const k = `${r.day}|${r.variantId}|${r.channel}`;
    const f = acc.get(k) ?? { day: r.day, variantId: r.variantId, locationKey: ALL, channel: r.channel, sold: 0, returned: 0, gross: 0 };
    f.sold += r.sold;
    f.returned += r.returned;
    f.gross += r.gross;
    acc.set(k, f);
  }
  return [...acc.values()].map((f) => ({ ...f, sold: Math.round(f.sold), returned: Math.round(f.returned), gross: round2(f.gross) }));
}

/**
 * Stock rows → facts. Rows whose location name has no Location are skipped (reported).
 * endUnits keeps zero and negative ending stock as reported (never clamped).
 */
export function stockFacts(
  rows: StockRow[],
  range: DayRange,
  locationId: (name: string) => string | undefined,
): { facts: StockFact[]; unmapped: string[] } {
  const acc = new Map<string, StockFact>();
  const unmapped = new Set<string>();
  for (const r of latestByIdentity(rows, range, (x) => `${x.day}|${x.variantId}|${x.locationName}`)) {
    const id = locationId(r.locationName);
    if (!id) {
      unmapped.add(r.locationName);
      continue;
    }
    const k = `${r.day}|${r.variantId}|${id}`;
    const f = acc.get(k);
    if (f) {
      f.endUnits += r.endUnits;
      f.outOfStock = f.outOfStock && r.outOfStock;
    } else acc.set(k, { day: r.day, variantId: r.variantId, locationId: id, endUnits: r.endUnits, outOfStock: r.outOfStock });
  }
  return { facts: [...acc.values()].map((f) => ({ ...f, endUnits: Math.round(f.endUnits) })), unmapped: [...unmapped] };
}

export function sessionsFacts(rows: SessionsRow[], range: DayRange): SessionsFact[] {
  const acc = new Map<string, SessionsFact>();
  for (const r of latestByIdentity(rows, range, (x) => `${x.day}|${x.landingPath}|${x.trafficType}`)) {
    const k = `${r.day}|${r.landingPath}|${r.trafficType}`;
    const f = acc.get(k) ?? { day: r.day, landingPath: r.landingPath, trafficType: r.trafficType, sessions: 0, checkouts: 0 };
    f.sessions += r.sessions;
    f.checkouts += r.checkouts;
    acc.set(k, f);
  }
  return [...acc.values()].map((f) => ({ ...f, sessions: Math.round(f.sessions), checkouts: Math.round(f.checkouts) }));
}

export function shopDayFacts(rows: ShopDayRow[], range: DayRange): ShopFact[] {
  const acc = new Map<string, ShopFact>();
  for (const r of latestByIdentity(rows, range, (x) => x.day)) {
    const f = acc.get(r.day) ?? { day: r.day, orders: 0, gross: 0 };
    f.orders += r.orders;
    f.gross += r.gross;
    acc.set(r.day, f);
  }
  return [...acc.values()].map((f) => ({ ...f, orders: Math.round(f.orders), gross: round2(f.gross) }));
}
