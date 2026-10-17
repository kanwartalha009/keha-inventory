/**
 * Per-location planning (Pro `locations`; spec §4 J7, §7.1): one VariantMetric row per
 * variant × planning location (active warehouse or store), scope = Location.id. The rules
 * are in lib/compute-locations-shared (stores: their own sales; warehouses that count in
 * supplier orders: one pool, each with its stock share of the online demand, no own orders). Called once per compute run from
 * compute.server computeShop, after the online pool, with the inputs it already built
 * (ABC roles, suppliers, seasonal × trend). Reads only the database.
 *
 * Without the `locations` feature every location-scope row is deleted (nothing reads them:
 * the switcher ignores `?location` below Pro); a later upgrade recomputes them on the next
 * run. Rows of locations that are no longer active or no longer a warehouse / store are
 * deleted, and so are rows of variants no longer carried at a location.
 *
 * Only metrics: the action list and the money cards stay online-pool only.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { POOL_LOCATION_SELECT, SCOPE_ONLINE, buildSeries, countsForOnline, metricRow, type SalesDay } from "../lib/compute-shared";
import {
  carriedAt,
  demandSourceFor,
  keptScopes,
  locationStockDays,
  neutralLocation,
  poolWarehouse,
  shareSeries,
  warehouseShares,
  type DemandSource,
} from "../lib/compute-locations-shared";
import { computeVariant, type AbcRole, type DailyRow, type EngineSettings, type VariantResult } from "../lib/engine/index-shared";
import { seasonFacts, type VariantSeason } from "../lib/engine/season-shared";
import { serviceLevelFor, type SafetyLevelKey } from "../lib/engine/safety-shared";
import { casePackFor, type SupplierLite } from "../lib/supplier-shared";
import { planningLocations } from "../lib/locations-shared";
import { ALL, dayDate } from "../lib/sync/facts-shared";
import { writeVariantMetrics } from "./metric-writes.server";

/** Variant ids per `in` filter when reading one location's facts (bounded query size). */
const READ_CHUNK = 1000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export type LocationVariantPlan = {
  v: {
    id: string;
    productCreatedAt: Date | null;
    caseQty: number | null;
    price: unknown;
    cost: unknown;
    noReorder?: boolean | null;
    inventoryPolicy?: string | null;
  };
  supplier: (SupplierLite & { minOrder: number | null }) | null;
};

export type LocationComputeInput = {
  startedAt: Date;
  today: string;
  /** First day of the history window ("YYYY-MM-DD"). */
  from: string;
  /** The 90-day window as a Prisma date filter. */
  range: { gte: Date; lte: Date };
  overrides: Partial<EngineSettings>;
  safetyLevel: SafetyLevelKey;
  plans: readonly LocationVariantPlan[];
  roles: ReadonlyMap<string, AbcRole>;
  seasonOf: ReadonlyMap<string, VariantSeason>;
  /** The pool's weekly seasonal shape per variant (compute's curveFor; absent = flat). */
  curveOf?: ReadonlyMap<string, readonly (number | null)[] | null>;
  /** The online pool's daily series, last sale and first stock day (warehouses in the pool). */
  pool: {
    series: ReadonlyMap<string, DailyRow[]>;
    lastSale: ReadonlyMap<string, string | null>;
    dataSince: ReadonlyMap<string, string | null>;
  };
};

export type LocationComputeResult = { locations: number; metrics: number };

/** The one entry point compute calls. `enabled` = the plan includes `locations` (fail-open upstream). */
export async function syncLocationMetrics(shop: string, enabled: boolean, input: LocationComputeInput): Promise<LocationComputeResult> {
  if (!enabled) {
    await prisma.variantMetric.deleteMany({ where: { shop, scope: { not: SCOPE_ONLINE } } });
    return { locations: 0, metrics: 0 };
  }
  const rows = await prisma.location.findMany({ where: { shop }, select: { ...POOL_LOCATION_SELECT, name: true, role: true } });
  const planning = planningLocations(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  await prisma.variantMetric.deleteMany({ where: { shop, scope: { notIn: keptScopes(planning.map((l) => l.id)) } } });
  // H7: warehouses that count in supplier orders are planned as one pool — each gets its share
  // (by stock on hand) of the online demand: location view keys "online" + their own POS sales.
  const poolWh = planning.filter((l) => l.role === "warehouse" && countsForOnline(byId.get(l.id)!)).map((l) => l.id);
  const ids = input.plans.map((p) => p.v.id);
  const onlineSold = new Map<string, Map<string, number>>();
  const shares = new Map<string, Map<string, number>>();
  if (poolWh.length) {
    const [salesG, nowRows] = await Promise.all([
      chunked(ids, (chunk) =>
        prisma.salesDaily.groupBy({
          by: ["variantId", "day"],
          where: { shop, channel: ALL, locationKey: { in: ["online", ...poolWh] }, variantId: { in: chunk }, day: input.range },
          _sum: { sold: true },
        }),
      ),
      prisma.stockNow.findMany({ where: { shop, locationId: { in: poolWh } }, select: { variantId: true, locationId: true, onHand: true } }),
    ]);
    for (const g of salesG) {
      const m = onlineSold.get(g.variantId) ?? onlineSold.set(g.variantId, new Map()).get(g.variantId)!;
      m.set(dayKey(g.day), (m.get(dayKey(g.day)) ?? 0) + num(g._sum.sold));
    }
    const onHand = new Map<string, Map<string, number>>();
    for (const id of ids) onHand.set(id, new Map(poolWh.map((w) => [w, 0])));
    for (const r of nowRows) onHand.get(r.variantId)?.set(r.locationId, (onHand.get(r.variantId)!.get(r.locationId) ?? 0) + r.onHand);
    for (const [id, m] of onHand) shares.set(id, warehouseShares(m));
  }
  let metrics = 0;
  for (const l of planning) {
    const source = demandSourceFor(l.role, countsForOnline(byId.get(l.id)!));
    metrics += await computeLocation(shop, l.id, l.role, source, input, { onlineSold, shares });
  }
  return { locations: planning.length, metrics };
}

/** Runs `read` over the planned variant ids in chunks and concatenates the rows. */
async function chunked<T>(ids: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += READ_CHUNK) out.push(...(await read(ids.slice(i, i + READ_CHUNK))));
  return out;
}

async function computeLocation(
  shop: string,
  locationId: string,
  role: string,
  source: DemandSource,
  x: LocationComputeInput,
  pooled: { onlineSold: ReadonlyMap<string, ReadonlyMap<string, number>>; shares: ReadonlyMap<string, ReadonlyMap<string, number>> },
): Promise<number> {
  // Only the planned variants (active, tracked, not bundles), only the rate window (x.range).
  const ids = x.plans.map((p) => p.v.id);
  const [salesG, stockRows, lastSaleG, dataSinceG, stockNow] = await Promise.all([
    // Location view only: this location's POS sales.
    chunked(ids, (chunk) =>
      prisma.salesDaily.groupBy({
        by: ["variantId", "day"],
        where: { shop, channel: ALL, locationKey: locationId, variantId: { in: chunk }, day: x.range },
        _sum: { sold: true },
      }),
    ),
    chunked(ids, (chunk) =>
      prisma.stockDaily.findMany({
        where: { shop, locationId, variantId: { in: chunk }, day: x.range },
        select: { variantId: true, day: true, endUnits: true, outOfStock: true },
      }),
    ),
    prisma.salesDaily.groupBy({
      by: ["variantId"],
      where: { shop, channel: ALL, locationKey: locationId, sold: { gt: 0 }, day: { lt: dayDate(x.from) } },
      _max: { day: true },
    }),
    prisma.stockDaily.groupBy({ by: ["variantId"], where: { shop, locationId }, _min: { day: true } }),
    prisma.stockNow.findMany({ where: { shop, locationId }, select: { variantId: true, onHand: true, available: true, incoming: true } }),
  ]);

  const sales: SalesDay[] = salesG.map((g) => ({ variantId: g.variantId, day: dayKey(g.day), sold: num(g._sum.sold), gross: 0 }));
  const stock = locationStockDays(stockRows.map((r) => ({ variantId: r.variantId, day: dayKey(r.day), endUnits: r.endUnits, outOfStock: r.outOfStock })));
  const series = buildSeries(sales, stock);
  const lastSale = new Map(lastSaleG.map((g) => [g.variantId, g._max.day ? dayKey(g._max.day) : null]));
  const dataSince = new Map(dataSinceG.map((g) => [g.variantId, g._min.day ? dayKey(g._min.day) : null]));
  const now = new Map(stockNow.map((s) => [s.variantId, s]));
  const carried = carriedAt(now.keys(), new Set(stockRows.map((r) => r.variantId)));

  const ownSold = new Map<string, number>();
  for (const s of sales) ownSold.set(s.variantId, (ownSold.get(s.variantId) ?? 0) + s.sold);
  const fromPool = source === "online_pool";

  const results: { r: VariantResult; supplierId: string | null }[] = [];
  for (const { v, supplier } of x.plans) {
    if (!carried.has(v.id)) continue;
    const s = now.get(v.id);
    const season = x.seasonOf.get(v.id);
    const computed = computeVariant({
      id: v.id,
      isBundle: false,
      // A pool warehouse gets its share of the online demand on the pool's days (see the shared header).
      series: fromPool
        ? shareSeries(x.pool.series.get(v.id) ?? [], pooled.onlineSold.get(v.id), pooled.shares.get(v.id)?.get(locationId) ?? 0)
        : (series.get(v.id) ?? []),
      today: x.today,
      onHand: s?.available ?? 0, // planning position: Shopify available (may be negative), not on_hand (audit C2)
      incoming: s?.incoming ?? 0,
      role: x.roles.get(v.id) ?? "C",
      productCreatedAt: v.productCreatedAt ? v.productCreatedAt.toISOString() : null,
      lastSaleDay: (fromPool ? x.pool.lastSale.get(v.id) : lastSale.get(v.id)) ?? null,
      dataSinceDay: (fromPool ? x.pool.dataSince.get(v.id) : dataSince.get(v.id)) ?? null,
      supplierLeadTimeDays: supplier?.leadTimeDays ?? null,
      caseQty: casePackFor(v.caseQty, supplier),
      minOrder: supplier?.minOrder ?? null,
      seasonal: season?.seasonal ?? 1,
      trend: season?.trend ?? 1,
      plan: 1,
      seasonCurve: x.curveOf?.get(v.id) ?? null,
      noReorder: v.noReorder === true,
      sellsWhenOut: v.inventoryPolicy === "CONTINUE",
      price: numOrNull(v.price),
      cost: numOrNull(v.cost),
      settings: x.overrides,
    });
    const r = computed ? (fromPool ? poolWarehouse(computed) : neutralLocation(computed, source, ownSold.get(v.id) ?? 0)) : null;
    if (r) results.push({ r, supplierId: supplier?.id ?? null });
  }

  await writeVariantMetrics(
    shop,
    locationId,
    results.map(({ r, supplierId }) => {
      const season = x.seasonOf.get(r.id);
      const m = metricRow(r, {
        location: locationId,
        demandSource: source,
        ...(fromPool ? { poolShare: pooled.shares.get(r.id)?.get(locationId) ?? 0 } : {}),
        season: season ? seasonFacts(season) : null,
        safetyLevel: x.safetyLevel,
        serviceLevel: serviceLevelFor(x.safetyLevel, r.role),
        supplierId,
        kehaOnOrder: 0,
        // The engine's safety stock (z × σ × √(lead + cycle)): transfers' keep level reads it.
        safety: r.safety,
      });
      return {
        variantId: r.id,
        rate: m.rate,
        sigma: m.sigma,
        daysLeft: m.daysLeft,
        neverRunsOut: m.neverRunsOut,
        status: m.status,
        role: m.role,
        orderQty: m.orderQty,
        orderBy: m.orderBy ? dayDate(m.orderBy) : null,
        computedAt: x.startedAt,
        inputs: m.inputs as Prisma.InputJsonValue,
      };
    }),
  );
  // Variants no longer carried here (or no longer planned) lose their row for this location.
  await prisma.variantMetric.deleteMany({ where: { shop, scope: locationId, computedAt: { lt: x.startedAt } } });
  return results.length;
}
