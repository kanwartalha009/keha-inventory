/**
 * Reads of the stored first / last days (DB scale #3; lib/sync/fact-days-shared, kept current by
 * services/sync/fact-days.server). Each reader falls back to the facts — the exact query the
 * readers ran before — while the shop's days are not built (Shop.factDaysAt null) or a Variant
 * column is not known yet (null), so results never depend on whether the days exist.
 */
import prisma from "../db.server";
import { facts } from "../services/facts-store.server";
import { ALL, dayDate } from "../lib/sync/facts-shared";
import { mapLimit, slices } from "../lib/concurrency-shared";

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const READ_CHUNK = 5000;
const LOOKUP_CONCURRENCY = 4;

/** True once the shop's stored days were built (readers may trust VariantLocationDays). */
export async function factDaysReady(shop: string): Promise<boolean> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { factDaysAt: true } });
  return !!row?.factDaysAt;
}

/**
 * First channel-view sales day per variant, in the shape of
 * `salesDaily.groupBy({ by: ["variantId"], where: { locationKey: "all" }, _min: { day } })` (the
 * order plan's last-year check). Stored Variant.firstSaleDay where known; the facts for the rest
 * (variants never sold, or not filled yet — a short read: they have few or no sales rows).
 */
export async function firstSaleRows(shop: string, ids: readonly string[]): Promise<{ variantId: string; _min: { day: Date | null } }[]> {
  const out: { variantId: string; _min: { day: Date | null } }[] = [];
  const unknown: string[] = [];
  for (const chunk of slices(ids, READ_CHUNK)) {
    for (const v of await prisma.variant.findMany({ where: { shop, id: { in: chunk } }, select: { id: true, firstSaleDay: true } })) {
      if (v.firstSaleDay) out.push({ variantId: v.id, _min: { day: v.firstSaleDay } });
      else unknown.push(v.id);
    }
  }
  for (const chunk of slices(unknown, READ_CHUNK)) {
    out.push(...(await facts.salesDaily.groupBy({ by: ["variantId"], where: { shop, variantId: { in: chunk }, locationKey: ALL }, _min: { day: true } })));
  }
  return out;
}

export type LocationDayRow = { locationKey: string; firstStockDay: string | null; lastSaleDay: string | null };

/** VariantLocationDays of `ids`, by variant (complete once the shop's days are built). */
export async function locationDays(shop: string, ids: readonly string[]): Promise<Map<string, LocationDayRow[]>> {
  const out = new Map<string, LocationDayRow[]>();
  for (const chunk of slices(ids, READ_CHUNK)) {
    const rows = await prisma.variantLocationDays.findMany({
      where: { shop, variantId: { in: chunk } },
      select: { variantId: true, locationKey: true, firstStockDay: true, lastSaleDay: true },
    });
    for (const r of rows) {
      (out.get(r.variantId) ?? out.set(r.variantId, []).get(r.variantId)!).push({ locationKey: r.locationKey, firstStockDay: iso(r.firstStockDay), lastSaleDay: iso(r.lastSaleDay) });
    }
  }
  return out;
}

/** A SalesDaily filter for one sales view (compute-shared demandWhere, or one location's view). */
export type SalesViewWhere =
  | { locationKey: string }
  | { locationKey: string; channel: { notIn: string[] } }
  | { channel: string; locationKey: string | { notIn: string[] } };

/**
 * The last day with sold > 0 BEFORE `from` in one sales view, per variant — exact, one short
 * index walk per variant (SalesDaily (shop, variantId, day), newest first). For the few variants
 * whose stored last sale is inside the 90-day window but whose series cannot tell.
 */
export async function lastSaleBefore(shop: string, ids: readonly string[], from: string, view: SalesViewWhere): Promise<Map<string, string | null>> {
  const days = await mapLimit(ids, LOOKUP_CONCURRENCY, async (variantId) => {
    const r = await facts.salesDaily.findFirst({
      where: { shop, variantId, ...view, sold: { gt: 0 }, day: { lt: dayDate(from) } },
      orderBy: { day: "desc" },
      select: { day: true },
    });
    return iso(r?.day);
  });
  return new Map(ids.map((id, i) => [id, days[i]]));
}

/**
 * The facts' answer, as compute read it before the days were stored: last sale before `from`
 * (view, sold > 0) and the first stock day at `locations`, per variant of `ids`. Each read covers
 * these variants' whole history — only while the shop's days are not built.
 */
export async function legacyDays(
  shop: string,
  ids: readonly string[],
  x: { from: string; view: SalesViewWhere; locations: readonly string[] },
): Promise<{ lastSale: Map<string, string | null>; dataSince: Map<string, string | null> }> {
  // Every id gets an answer (null = none), as the stored-days path gives.
  const lastSale = new Map<string, string | null>(ids.map((id) => [id, null]));
  const dataSince = new Map<string, string | null>(ids.map((id) => [id, null]));
  for (const chunk of slices(ids, READ_CHUNK)) {
    const [lastG, sinceG] = await Promise.all([
      facts.salesDaily.groupBy({ by: ["variantId"], where: { shop, variantId: { in: chunk }, ...x.view, sold: { gt: 0 }, day: { lt: dayDate(x.from) } }, _max: { day: true } }),
      x.locations.length
        ? facts.stockDaily.groupBy({ by: ["variantId"], where: { shop, variantId: { in: chunk }, locationId: { in: [...x.locations] } }, _min: { day: true } })
        : Promise.resolve([] as { variantId: string; _min: { day: Date | null } }[]),
    ]);
    for (const g of lastG) lastSale.set(g.variantId, iso(g._max.day));
    for (const g of sinceG) dataSince.set(g.variantId, iso(g._min.day));
  }
  return { lastSale, dataSince };
}
