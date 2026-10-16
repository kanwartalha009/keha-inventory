/**
 * Per-location planning (Pro `locations`; spec §4 J7, §7.1): one VariantMetric row per
 * variant × planning location (active warehouse or store), scope = Location.id. The rules
 * are in lib/compute-locations-shared. Called once per compute run from
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
import { SCOPE_ONLINE, buildSeries, metricRow, type SalesDay } from "../lib/compute-shared";
import { carriedAt, keptScopes, locationStockDays } from "../lib/compute-locations-shared";
import { computeVariant, type AbcRole, type EngineSettings, type VariantResult } from "../lib/engine/index-shared";
import { seasonFacts, type VariantSeason } from "../lib/engine/season-shared";
import { serviceLevelFor, type SafetyLevelKey } from "../lib/engine/safety-shared";
import { casePackFor, type SupplierLite } from "../lib/supplier-shared";
import { planningLocations } from "../lib/locations-shared";
import { ALL, dayDate } from "../lib/sync/facts-shared";

const WRITE_BATCH = 200;
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
};

export type LocationComputeResult = { locations: number; metrics: number };

/** The one entry point compute calls. `enabled` = the plan includes `locations` (fail-open upstream). */
export async function syncLocationMetrics(shop: string, enabled: boolean, input: LocationComputeInput): Promise<LocationComputeResult> {
  if (!enabled) {
    await prisma.variantMetric.deleteMany({ where: { shop, scope: { not: SCOPE_ONLINE } } });
    return { locations: 0, metrics: 0 };
  }
  const rows = await prisma.location.findMany({ where: { shop }, select: { id: true, name: true, active: true, role: true } });
  const planning = planningLocations(rows);
  await prisma.variantMetric.deleteMany({ where: { shop, scope: { notIn: keptScopes(planning.map((l) => l.id)) } } });
  let metrics = 0;
  for (const l of planning) metrics += await computeLocation(shop, l.id, input);
  return { locations: planning.length, metrics };
}

async function computeLocation(shop: string, locationId: string, x: LocationComputeInput): Promise<number> {
  const [salesG, stockRows, lastSaleG, dataSinceG, stockNow] = await Promise.all([
    // Location view only: this location's POS sales.
    prisma.salesDaily.groupBy({
      by: ["variantId", "day"],
      where: { shop, channel: ALL, locationKey: locationId, day: x.range },
      _sum: { sold: true },
    }),
    prisma.stockDaily.findMany({
      where: { shop, locationId, day: x.range },
      select: { variantId: true, day: true, endUnits: true, outOfStock: true },
    }),
    prisma.salesDaily.groupBy({
      by: ["variantId"],
      where: { shop, channel: ALL, locationKey: locationId, sold: { gt: 0 }, day: { lt: dayDate(x.from) } },
      _max: { day: true },
    }),
    prisma.stockDaily.groupBy({ by: ["variantId"], where: { shop, locationId }, _min: { day: true } }),
    prisma.stockNow.findMany({ where: { shop, locationId }, select: { variantId: true, onHand: true, incoming: true } }),
  ]);

  const sales: SalesDay[] = salesG.map((g) => ({ variantId: g.variantId, day: dayKey(g.day), sold: num(g._sum.sold), gross: 0 }));
  const stock = locationStockDays(stockRows.map((r) => ({ variantId: r.variantId, day: dayKey(r.day), endUnits: r.endUnits, outOfStock: r.outOfStock })));
  const series = buildSeries(sales, stock);
  const lastSale = new Map(lastSaleG.map((g) => [g.variantId, g._max.day ? dayKey(g._max.day) : null]));
  const dataSince = new Map(dataSinceG.map((g) => [g.variantId, g._min.day ? dayKey(g._min.day) : null]));
  const now = new Map(stockNow.map((s) => [s.variantId, s]));
  const carried = carriedAt(now.keys(), new Set(stockRows.map((r) => r.variantId)));

  const results: { r: VariantResult; supplierId: string | null }[] = [];
  for (const { v, supplier } of x.plans) {
    if (!carried.has(v.id)) continue;
    const s = now.get(v.id);
    const season = x.seasonOf.get(v.id);
    const r = computeVariant({
      id: v.id,
      isBundle: false,
      series: series.get(v.id) ?? [],
      today: x.today,
      onHand: s?.onHand ?? 0,
      incoming: s?.incoming ?? 0,
      role: x.roles.get(v.id) ?? "C",
      productCreatedAt: v.productCreatedAt ? v.productCreatedAt.toISOString() : null,
      lastSaleDay: lastSale.get(v.id) ?? null,
      dataSinceDay: dataSince.get(v.id) ?? null,
      supplierLeadTimeDays: supplier?.leadTimeDays ?? null,
      caseQty: casePackFor(v.caseQty, supplier),
      minOrder: supplier?.minOrder ?? null,
      seasonal: season?.seasonal ?? 1,
      trend: season?.trend ?? 1,
      plan: 1,
      price: numOrNull(v.price),
      cost: numOrNull(v.cost),
      settings: x.overrides,
    });
    if (r) results.push({ r, supplierId: supplier?.id ?? null });
  }

  for (let i = 0; i < results.length; i += WRITE_BATCH) {
    await prisma.$transaction(
      results.slice(i, i + WRITE_BATCH).map(({ r, supplierId }) => {
        const season = x.seasonOf.get(r.id);
        const m = metricRow(r, {
          location: locationId,
          season: season ? seasonFacts(season) : null,
          safetyLevel: x.safetyLevel,
          serviceLevel: serviceLevelFor(x.safetyLevel, r.role),
          supplierId,
          kehaOnOrder: 0,
        });
        const data = {
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
        return prisma.variantMetric.upsert({
          where: { shop_variantId_scope: { shop, variantId: r.id, scope: locationId } },
          create: { shop, variantId: r.id, scope: locationId, ...data },
          update: data,
        });
      }),
    );
  }
  // Variants no longer carried here (or no longer planned) lose their row for this location.
  await prisma.variantMetric.deleteMany({ where: { shop, scope: locationId, computedAt: { lt: x.startedAt } } });
  return results.length;
}
