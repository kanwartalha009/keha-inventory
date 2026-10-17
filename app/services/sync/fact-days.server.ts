/**
 * Stored first / last days (DB scale #3; meaning and merge rules in lib/sync/fact-days-shared):
 *
 *  - collectorFor / applyDays: every sync write (backfill + nightly, facts.server storeHistory)
 *    collects the extreme days of the facts it wrote and merges them into Variant and
 *    VariantLocationDays once the step is over — only once the shop's days were built
 *    (Shop.factDaysAt); before that nothing is kept and the build reads everything.
 *  - buildFactDays: the one-time build from the facts (compute runs it when Shop.factDaysAt is
 *    null), in variant chunks, then sets Shop.factDaysAt.
 *  - fixDaysAfterRetention: retention deletes facts older than 25 months; first days older than
 *    the cutoff move to the first remaining row (a 7-day window read, then single-variant
 *    lookups for the rest), last sales older than the cutoff become null — as a fresh scan
 *    would read them.
 *  - fillVariantDays: compute's lazy fill of null Variant columns (variants the catalog created
 *    after their first facts, or never sold / stocked): one grouped read per chunk; values found
 *    are stored.
 *
 * Everything is Prisma reads and grouped `updateMany` / `createMany` writes: values repeat a lot
 * (most variants share their first stock day and last sale day), so a step writes one statement
 * per (column, day) — and only for values that changed. Never throws into the sync's result:
 * applyDays failing marks the shop not built (factDaysAt = null) so the next compute rebuilds.
 */
import prisma from "../../db.server";
import {
  RECOMPUTE,
  locKey,
  mergeFirst,
  mergeLast,
  newCollector,
  partsHull,
  splitLocKey,
  touchedVariants,
  type DaysCollector,
  type Merged,
} from "../../lib/sync/fact-days-shared";
import { ALL, dayDate } from "../../lib/sync/facts-shared";
import { addDays, type DayRange } from "../../lib/sync/shopifyql-shared";
import { mapLimit, slices } from "../../lib/concurrency-shared";

/** Variant ids per read (Prisma `in` lists stay far below Postgres's bind-parameter limit). */
export const DAYS_READ_CHUNK = 5000;
/** Ids per grouped write. */
const WRITE_CHUNK = 5000;
/** Parallel single-row lookups (each holds a pool connection). */
const LOOKUP_CONCURRENCY = 4;
/** Retention: days after the cutoff read in one grouped query before single-variant lookups. */
const RETENTION_WINDOW_DAYS = 7;

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

type VariantCol = "firstStockDay" | "firstSaleDay" | "lastSaleDay";
type LocCol = "firstStockDay" | "lastSaleDay";

/** Pending writes: column → day ("" = null) → ids / keys. */
class Writes<C extends string> {
  readonly byCol = new Map<C, Map<string, string[]>>();
  set(col: C, day: string | null, id: string) {
    const m = this.byCol.get(col) ?? this.byCol.set(col, new Map()).get(col)!;
    const k = day ?? "";
    (m.get(k) ?? m.set(k, []).get(k)!).push(id);
  }
  get size() {
    let n = 0;
    for (const m of this.byCol.values()) for (const ids of m.values()) n += ids.length;
    return n;
  }
}

async function writeVariantCols(shop: string, w: Writes<VariantCol>): Promise<void> {
  for (const [col, byDay] of w.byCol)
    for (const [day, ids] of byDay)
      for (const chunk of slices(ids, WRITE_CHUNK)) {
        await prisma.variant.updateMany({ where: { shop, id: { in: chunk } }, data: { [col]: day ? dayDate(day) : null } });
      }
}

/** Existing rows: grouped updates per (column, location key, day); new rows: createMany. */
async function writeLocationRows(
  shop: string,
  w: Writes<LocCol>,
  created: Map<string, { firstStockDay: string | null; lastSaleDay: string | null }>,
): Promise<void> {
  const rows = [...created].map(([k, v]) => {
    const { variantId, locationKey } = splitLocKey(k);
    return { shop, variantId, locationKey, firstStockDay: v.firstStockDay ? dayDate(v.firstStockDay) : null, lastSaleDay: v.lastSaleDay ? dayDate(v.lastSaleDay) : null };
  });
  for (const chunk of slices(rows, WRITE_CHUNK)) await prisma.variantLocationDays.createMany({ data: chunk, skipDuplicates: true });
  for (const [col, byDay] of w.byCol)
    for (const [day, keys] of byDay) {
      const byLocation = new Map<string, string[]>();
      for (const k of keys) {
        const { variantId, locationKey } = splitLocKey(k);
        (byLocation.get(locationKey) ?? byLocation.set(locationKey, []).get(locationKey)!).push(variantId);
      }
      for (const [locationKey, ids] of byLocation)
        for (const chunk of slices(ids, WRITE_CHUNK)) {
          await prisma.variantLocationDays.updateMany({ where: { shop, locationKey, variantId: { in: chunk } }, data: { [col]: day ? dayDate(day) : null } });
        }
    }
}

// ---------------------------------------------------------------------------
// Single-row lookups (index (shop, variantId, day): one short index walk each)
// ---------------------------------------------------------------------------

type Lookup = { col: VariantCol | LocCol; variantId: string; locationKey?: string };

/** The current first / last day of one variant's facts for a column (exact: reads what is stored now). */
async function lookup(shop: string, q: Lookup): Promise<string | null> {
  if (q.col === "firstStockDay") {
    const r = await prisma.stockDaily.findFirst({
      where: { shop, variantId: q.variantId, ...(q.locationKey ? { locationId: q.locationKey } : {}) },
      orderBy: { day: "asc" },
      select: { day: true },
    });
    return iso(r?.day);
  }
  if (q.col === "firstSaleDay") {
    const r = await prisma.salesDaily.findFirst({ where: { shop, variantId: q.variantId, locationKey: ALL }, orderBy: { day: "asc" }, select: { day: true } });
    return iso(r?.day);
  }
  const view = q.locationKey ? { channel: ALL, locationKey: q.locationKey } : { locationKey: ALL };
  const r = await prisma.salesDaily.findFirst({ where: { shop, variantId: q.variantId, ...view, sold: { gt: 0 } }, orderBy: { day: "desc" }, select: { day: true } });
  return iso(r?.day);
}

// ---------------------------------------------------------------------------
// Sync writes → merge
// ---------------------------------------------------------------------------

/** A collector for one sync step, or null while the shop's days are not built (nothing to keep current). */
export async function collectorFor(shop: string): Promise<DaysCollector | null> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { factDaysAt: true } });
  return row?.factDaysAt ? newCollector() : null;
}

/**
 * Merges what one step wrote into the stored days. Never throws: on a failure the shop is marked
 * not built (factDaysAt = null), so readers go back to the facts and the next compute rebuilds.
 */
export async function applyDays(shop: string, c: DaysCollector): Promise<void> {
  if (!c.parts.length) return;
  try {
    await merge(shop, c);
  } catch (e) {
    console.error(`[sync/days] ${shop}: keeping the stored days current failed; they will be rebuilt`, e);
    await prisma.shop.update({ where: { domain: shop }, data: { factDaysAt: null } }).catch(() => {});
  }
}

async function merge(shop: string, c: DaysCollector): Promise<void> {
  const hull = partsHull(c.parts)!;
  const inHull = { gte: dayDate(hull.since), lte: dayDate(hull.until) };
  const cols: VariantCol[] = [...(c.stock ? (["firstStockDay"] as const) : []), ...(c.sales ? (["firstSaleDay", "lastSaleDay"] as const) : [])];
  const locCols: LocCol[] = [...(c.stock ? (["firstStockDay"] as const) : []), ...(c.sales ? (["lastSaleDay"] as const) : [])];

  // Variants written now, plus those whose stored day lies in the rewritten days (it may be gone).
  const ids = new Set(touchedVariants(c));
  const [vHull, lHull] = await Promise.all([
    prisma.variant.findMany({ where: { shop, OR: cols.map((col) => ({ [col]: inHull })) }, select: { id: true } }),
    prisma.variantLocationDays.findMany({ where: { shop, OR: locCols.map((col) => ({ [col]: inHull })) }, select: { variantId: true } }),
  ]);
  for (const r of vHull) ids.add(r.id);
  for (const r of lHull) ids.add(r.variantId);

  const chunkVariant = (col: VariantCol, id: string) =>
    col === "firstStockDay" ? c.stock?.variantFirst.get(id) : col === "firstSaleDay" ? c.sales?.variantFirst.get(id) : c.sales?.variantLast.get(id);
  const chunkLocation = (col: LocCol, k: string) => (col === "firstStockDay" ? c.stock?.locationFirst.get(k) : c.sales?.locationLast.get(k));
  const mergeCol = (col: string, stored: string | null, chunk: string | undefined): Merged =>
    col === "lastSaleDay" ? mergeLast(stored, chunk, c.parts) : mergeFirst(stored, chunk, c.parts);

  const vWrites = new Writes<VariantCol>();
  const lWrites = new Writes<LocCol>();
  const created = new Map<string, { firstStockDay: string | null; lastSaleDay: string | null }>();
  const lookups: { q: Lookup; apply: (day: string | null) => void }[] = [];
  // The location keys this step wrote, per variant.
  const writtenKeys = new Map<string, string[]>();
  for (const k of [...(c.stock?.locationFirst.keys() ?? []), ...(c.sales?.locationLast.keys() ?? [])]) {
    const { variantId } = splitLocKey(k);
    (writtenKeys.get(variantId) ?? writtenKeys.set(variantId, []).get(variantId)!).push(k);
  }

  for (const chunk of slices([...ids], DAYS_READ_CHUNK)) {
    const [variants, locRows] = await Promise.all([
      prisma.variant.findMany({ where: { shop, id: { in: chunk } }, select: { id: true, firstStockDay: true, firstSaleDay: true, lastSaleDay: true } }),
      prisma.variantLocationDays.findMany({ where: { shop, variantId: { in: chunk } }, select: { variantId: true, locationKey: true, firstStockDay: true, lastSaleDay: true } }),
    ]);
    // Variant columns: only known (non-null) values move; null stays for compute's lazy fill.
    for (const v of variants)
      for (const col of cols) {
        const stored = iso(v[col]);
        if (stored === null) continue;
        const m = mergeCol(col, stored, chunkVariant(col, v.id));
        if (m === RECOMPUTE) lookups.push({ q: { col, variantId: v.id }, apply: (day) => vWrites.set(col, day, v.id) });
        else if (m !== stored) vWrites.set(col, m, v.id);
      }
    // Location rows: complete once built — absent = none.
    const existing = new Map(locRows.map((r) => [locKey(r.variantId, r.locationKey), r]));
    const keys = new Set<string>(existing.keys());
    for (const id of chunk) for (const k of writtenKeys.get(id) ?? []) keys.add(k);
    for (const k of keys) {
      const row = existing.get(k);
      const { variantId, locationKey } = splitLocKey(k);
      for (const col of locCols) {
        const stored = row ? iso(row[col]) : null;
        const m = mergeCol(col, stored, chunkLocation(col, k));
        const set = (day: string | null) => {
          if (row) lWrites.set(col, day, k);
          else {
            const n = created.get(k) ?? created.set(k, { firstStockDay: null, lastSaleDay: null }).get(k)!;
            n[col] = day;
          }
        };
        if (m === RECOMPUTE) lookups.push({ q: { col, variantId, locationKey }, apply: set });
        else if (m !== stored) set(m);
      }
    }
  }
  const found = await mapLimit(lookups, LOOKUP_CONCURRENCY, (l) => lookup(shop, l.q));
  lookups.forEach((l, i) => l.apply(found[i]));
  // Rows that would be created with nothing in them are not created.
  for (const [k, v] of created) if (v.firstStockDay === null && v.lastSaleDay === null) created.delete(k);
  await writeVariantCols(shop, vWrites);
  await writeLocationRows(shop, lWrites, created);
}

// ---------------------------------------------------------------------------
// One-time build
// ---------------------------------------------------------------------------

/** Variant ids per grouped read in the build (each read covers those variants' whole history). */
export const BUILD_CHUNK = 2000;

/**
 * Builds every stored day of the shop from its facts (once per shop; compute calls it while
 * Shop.factDaysAt is null) and sets factDaysAt. Variant chunks of BUILD_CHUNK; the shop's
 * VariantLocationDays are replaced. Must run under the shop's job lock (no sync write meanwhile).
 */
export async function buildFactDays(shop: string, now: Date = new Date()): Promise<{ variants: number; locationRows: number }> {
  const all = await prisma.variant.findMany({ where: { shop }, select: { id: true } });
  const vWrites = new Writes<VariantCol>();
  const locRows: { shop: string; variantId: string; locationKey: string; firstStockDay: Date | null; lastSaleDay: Date | null }[] = [];
  for (const chunk of slices(all.map((v) => v.id), BUILD_CHUNK)) {
    const ids = { in: chunk };
    const [stockG, firstSaleG, lastSaleG, locSaleG] = await Promise.all([
      prisma.stockDaily.groupBy({ by: ["variantId", "locationId"], where: { shop, variantId: ids }, _min: { day: true } }),
      prisma.salesDaily.groupBy({ by: ["variantId"], where: { shop, variantId: ids, locationKey: ALL }, _min: { day: true } }),
      prisma.salesDaily.groupBy({ by: ["variantId"], where: { shop, variantId: ids, locationKey: ALL, sold: { gt: 0 } }, _max: { day: true } }),
      prisma.salesDaily.groupBy({ by: ["variantId", "locationKey"], where: { shop, variantId: ids, channel: ALL, sold: { gt: 0 } }, _max: { day: true } }),
    ]);
    const firstStock = new Map<string, string>();
    const rows = new Map<string, { firstStockDay: string | null; lastSaleDay: string | null }>();
    for (const g of stockG) {
      const day = iso(g._min.day);
      if (!day) continue;
      const cur = firstStock.get(g.variantId);
      if (!cur || day < cur) firstStock.set(g.variantId, day);
      rows.set(locKey(g.variantId, g.locationId), { firstStockDay: day, lastSaleDay: null });
    }
    for (const g of locSaleG) {
      const day = iso(g._max.day);
      if (!day) continue;
      const k = locKey(g.variantId, g.locationKey);
      const r = rows.get(k) ?? rows.set(k, { firstStockDay: null, lastSaleDay: null }).get(k)!;
      r.lastSaleDay = day;
    }
    const firstSale = new Map(firstSaleG.map((g) => [g.variantId, iso(g._min.day)]));
    const lastSale = new Map(lastSaleG.map((g) => [g.variantId, iso(g._max.day)]));
    for (const id of chunk) {
      vWrites.set("firstStockDay", firstStock.get(id) ?? null, id);
      vWrites.set("firstSaleDay", firstSale.get(id) ?? null, id);
      vWrites.set("lastSaleDay", lastSale.get(id) ?? null, id);
    }
    for (const [k, r] of rows) {
      const { variantId, locationKey } = splitLocKey(k);
      locRows.push({ shop, variantId, locationKey, firstStockDay: r.firstStockDay ? dayDate(r.firstStockDay) : null, lastSaleDay: r.lastSaleDay ? dayDate(r.lastSaleDay) : null });
    }
  }
  await writeVariantCols(shop, vWrites);
  await prisma.variantLocationDays.deleteMany({ where: { shop } });
  for (const chunk of slices(locRows, WRITE_CHUNK)) await prisma.variantLocationDays.createMany({ data: chunk, skipDuplicates: true });
  await prisma.shop.update({ where: { domain: shop }, data: { factDaysAt: now } });
  return { variants: all.length, locationRows: locRows.length };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * After retention deleted facts before `cutoff`: stored days older than the cutoff are set to what
 * the remaining facts say. Last sales before the cutoff have no row left → null. First days move
 * to the first remaining row: one grouped read of the RETENTION_WINDOW_DAYS days from the cutoff
 * (stock is daily, so nearly every variant is found there), single lookups for the rest.
 */
export async function fixDaysAfterRetention(shop: string, cutoff: string): Promise<number> {
  try {
    return await fixAfterRetention(shop, cutoff);
  } catch (e) {
    console.error(`[sync/days] ${shop}: moving the stored first days past the retention cutoff failed; they will be rebuilt`, e);
    await prisma.shop.update({ where: { domain: shop }, data: { factDaysAt: null } }).catch(() => {});
    return 0;
  }
}

async function fixAfterRetention(shop: string, cutoff: string): Promise<number> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { factDaysAt: true } });
  if (!row?.factDaysAt) return 0;
  const before = { lt: dayDate(cutoff) };
  const window = { gte: dayDate(cutoff), lte: dayDate(addDays(cutoff, RETENTION_WINDOW_DAYS - 1)) };
  const [variants, locs] = await Promise.all([
    prisma.variant.findMany({
      where: { shop, OR: [{ firstStockDay: before }, { firstSaleDay: before }, { lastSaleDay: before }] },
      select: { id: true, firstStockDay: true, firstSaleDay: true, lastSaleDay: true },
    }),
    prisma.variantLocationDays.findMany({
      where: { shop, OR: [{ firstStockDay: before }, { lastSaleDay: before }] },
      select: { variantId: true, locationKey: true, firstStockDay: true, lastSaleDay: true },
    }),
  ]);
  const vWrites = new Writes<VariantCol>();
  const lWrites = new Writes<LocCol>();
  const lookups: { q: Lookup; apply: (day: string | null) => void }[] = [];
  const old = (d: Date | null) => d !== null && iso(d)! < cutoff;

  for (const v of variants) if (old(v.lastSaleDay)) vWrites.set("lastSaleDay", null, v.id);
  for (const l of locs) if (old(l.lastSaleDay)) lWrites.set("lastSaleDay", null, locKey(l.variantId, l.locationKey));

  const stockIds = variants.filter((v) => old(v.firstStockDay)).map((v) => v.id);
  const saleIds = variants.filter((v) => old(v.firstSaleDay)).map((v) => v.id);
  const locStock = locs.filter((l) => old(l.firstStockDay));
  const stockFound = new Map<string, string>();
  const saleFound = new Map<string, string>();
  const locFound = new Map<string, string>();
  for (const chunk of slices(stockIds, DAYS_READ_CHUNK)) {
    for (const g of await prisma.stockDaily.groupBy({ by: ["variantId"], where: { shop, variantId: { in: chunk }, day: window }, _min: { day: true } }))
      if (g._min.day) stockFound.set(g.variantId, iso(g._min.day)!);
  }
  for (const chunk of slices(saleIds, DAYS_READ_CHUNK)) {
    for (const g of await prisma.salesDaily.groupBy({ by: ["variantId"], where: { shop, variantId: { in: chunk }, locationKey: ALL, day: window }, _min: { day: true } }))
      if (g._min.day) saleFound.set(g.variantId, iso(g._min.day)!);
  }
  for (const chunk of slices([...new Set(locStock.map((l) => l.variantId))], DAYS_READ_CHUNK)) {
    for (const g of await prisma.stockDaily.groupBy({ by: ["variantId", "locationId"], where: { shop, variantId: { in: chunk }, day: window }, _min: { day: true } }))
      if (g._min.day) locFound.set(locKey(g.variantId, g.locationId), iso(g._min.day)!);
  }
  for (const id of stockIds) {
    const day = stockFound.get(id);
    if (day) vWrites.set("firstStockDay", day, id);
    else lookups.push({ q: { col: "firstStockDay", variantId: id }, apply: (d) => vWrites.set("firstStockDay", d, id) });
  }
  for (const id of saleIds) {
    const day = saleFound.get(id);
    if (day) vWrites.set("firstSaleDay", day, id);
    else lookups.push({ q: { col: "firstSaleDay", variantId: id }, apply: (d) => vWrites.set("firstSaleDay", d, id) });
  }
  for (const l of locStock) {
    const k = locKey(l.variantId, l.locationKey);
    const day = locFound.get(k);
    if (day) lWrites.set("firstStockDay", day, k);
    else lookups.push({ q: { col: "firstStockDay", variantId: l.variantId, locationKey: l.locationKey }, apply: (d) => lWrites.set("firstStockDay", d, k) });
  }
  const found = await mapLimit(lookups, LOOKUP_CONCURRENCY, (l) => lookup(shop, l.q));
  lookups.forEach((l, i) => l.apply(found[i]));
  await writeVariantCols(shop, vWrites);
  await writeLocationRows(shop, lWrites, new Map());
  return vWrites.size + lWrites.size;
}

// ---------------------------------------------------------------------------
// Compute's lazy fill
// ---------------------------------------------------------------------------

export type VariantDays = { firstStockDay: string | null; firstSaleDay: string | null; lastSaleDay: string | null };

/**
 * Null Variant columns of `ids`, read from the facts (grouped, one read per column per chunk) and
 * stored where a value was found. Returns the values for every id asked (null = none).
 */
export async function fillVariantDays(
  shop: string,
  missing: { firstStockDay: string[]; firstSaleDay: string[]; lastSaleDay: string[] },
): Promise<Map<string, Partial<VariantDays>>> {
  const out = new Map<string, Partial<VariantDays>>();
  const put = (id: string, col: VariantCol, day: string | null) => {
    const cur = out.get(id) ?? out.set(id, {}).get(id)!;
    cur[col] = day;
  };
  const w = new Writes<VariantCol>();
  for (const chunk of slices(missing.firstStockDay, DAYS_READ_CHUNK)) {
    const g = new Map((await prisma.stockDaily.groupBy({ by: ["variantId"], where: { shop, variantId: { in: chunk } }, _min: { day: true } })).map((r) => [r.variantId, iso(r._min.day)]));
    for (const id of chunk) put(id, "firstStockDay", g.get(id) ?? null);
  }
  for (const chunk of slices(missing.firstSaleDay, DAYS_READ_CHUNK)) {
    const g = new Map((await prisma.salesDaily.groupBy({ by: ["variantId"], where: { shop, variantId: { in: chunk }, locationKey: ALL }, _min: { day: true } })).map((r) => [r.variantId, iso(r._min.day)]));
    for (const id of chunk) put(id, "firstSaleDay", g.get(id) ?? null);
  }
  for (const chunk of slices(missing.lastSaleDay, DAYS_READ_CHUNK)) {
    const g = new Map((await prisma.salesDaily.groupBy({ by: ["variantId"], where: { shop, variantId: { in: chunk }, locationKey: ALL, sold: { gt: 0 } }, _max: { day: true } })).map((r) => [r.variantId, iso(r._max.day)]));
    for (const id of chunk) put(id, "lastSaleDay", g.get(id) ?? null);
  }
  for (const [id, v] of out) for (const col of ["firstStockDay", "firstSaleDay", "lastSaleDay"] as const) if (v[col]) w.set(col, v[col]!, id);
  await writeVariantCols(shop, w);
  return out;
}

/** Test helper / diagnostics: the range a collector rewrote. */
export function rewrittenRange(c: DaysCollector): DayRange | null {
  return partsHull(c.parts);
}
