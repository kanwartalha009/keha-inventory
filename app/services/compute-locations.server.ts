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
import { facts } from "./facts-store.server";
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
import { supplierLeadSigma } from "../lib/lead-time-shared";
import { planningLocations } from "../lib/locations-shared";
import { ALL, dayDate } from "../lib/sync/facts-shared";
import { sweepVariantMetrics, writeVariantMetrics } from "./metric-writes.server";
import { lastSaleBefore as storedLastSaleBefore } from "../lib/sync/fact-days-shared";
import { lastSaleBefore, legacyDays, locationDays, type LocationDayRow } from "../models/fact-days.server";

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
  /**
   * The online pool's daily series, last sale before the window and first stock day (warehouses
   * in the pool). A last sale `undefined` is not known yet (compute's poolDays): resolveLastSale
   * reads it, in place, for the variants whose share series cannot stand in for it.
   */
  pool: {
    series: ReadonlyMap<string, DailyRow[]>;
    lastSale: ReadonlyMap<string, string | null | undefined>;
    dataSince: ReadonlyMap<string, string | null>;
    resolveLastSale?: (ids: readonly string[]) => Promise<void>;
  };
  /** The shop's stored first / last days are built (DB scale #3): read them, not the facts. */
  daysReady?: boolean;
};

/** Does the series hold a day with a sale (the engine's own last sale)? */
const seriesSold = (rows: readonly DailyRow[] | undefined) => !!rows?.some((r) => Number.isFinite(r.sold) && r.sold > 0);

export type LocationComputeResult = { locations: number; metrics: number };

/** The planning locations of one compute run (prepareLocationMetrics), shared by its variant chunks. */
export type LocationRun = {
  planning: { id: string; role: string; source: DemandSource }[];
  /** Warehouses that count in supplier orders: one pool, each with its share of the online demand (H7). */
  poolWh: string[];
};

/**
 * Before the variant chunks (DB scale #4): the planning locations, and the rows of locations no
 * longer planned removed. Without the `locations` feature every location-scope row is removed and
 * null comes back (nothing to compute).
 */
export async function prepareLocationMetrics(shop: string, enabled: boolean): Promise<LocationRun | null> {
  if (!enabled) {
    await prisma.variantMetric.deleteMany({ where: { shop, scope: { not: SCOPE_ONLINE } } });
    await prisma.metricRun.deleteMany({ where: { shop, scope: { not: SCOPE_ONLINE } } });
    return null;
  }
  const rows = await prisma.location.findMany({ where: { shop }, select: { ...POOL_LOCATION_SELECT, name: true, role: true } });
  const planning = planningLocations(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  await prisma.variantMetric.deleteMany({ where: { shop, scope: { notIn: keptScopes(planning.map((l) => l.id)) } } });
  await prisma.metricRun.deleteMany({ where: { shop, scope: { notIn: keptScopes(planning.map((l) => l.id)) } } });
  return {
    planning: planning.map((l) => ({ id: l.id, role: l.role, source: demandSourceFor(l.role, countsForOnline(byId.get(l.id)!)) })),
    // H7: warehouses that count in supplier orders are planned as one pool — each gets its share
    // (by stock on hand) of the online demand: location view keys "online" + their own POS sales.
    poolWh: planning.filter((l) => l.role === "warehouse" && countsForOnline(byId.get(l.id)!)).map((l) => l.id),
  };
}

/** One chunk of planned variants (input.plans), every planning location. Returns the rows written. */
export async function locationMetricsChunk(shop: string, run: LocationRun, input: LocationComputeInput): Promise<number> {
  const { poolWh } = run;
  const ids = input.plans.map((p) => p.v.id);
  const onlineSold = new Map<string, Map<string, number>>();
  const shares = new Map<string, Map<string, number>>();
  if (poolWh.length) {
    const [salesG, nowRows] = await Promise.all([
      chunked(ids, (chunk) =>
        facts.salesDaily.groupBy({
          by: ["variantId", "day"],
          where: { shop, channel: ALL, locationKey: { in: ["online", ...poolWh] }, variantId: { in: chunk }, day: input.range },
          _sum: { sold: true },
        }),
      ),
      chunked(ids, (chunk) =>
        prisma.stockNow.findMany({ where: { shop, locationId: { in: poolWh }, variantId: { in: chunk } }, select: { variantId: true, locationId: true, onHand: true } }),
      ),
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
  // Stored first / last days per variant × location (DB scale #3), read once for every location.
  const days = input.daysReady ? await locationDays(shop, ids) : null;
  let metrics = 0;
  for (const l of run.planning) metrics += await computeLocation(shop, l.id, l.role, l.source, input, { onlineSold, shares, days });
  return metrics;
}

/** After every chunk: rows of variants no longer carried (or no longer planned) at a location go. */
export async function finishLocationMetrics(shop: string, run: LocationRun, startedAt: Date): Promise<void> {
  for (const l of run.planning) await sweepVariantMetrics(shop, l.id, startedAt);
}

/** All planned variants at once (prepare → one chunk → finish). `enabled` = the plan includes `locations` (fail-open upstream). */
export async function syncLocationMetrics(shop: string, enabled: boolean, input: LocationComputeInput): Promise<LocationComputeResult> {
  const run = await prepareLocationMetrics(shop, enabled);
  if (!run) return { locations: 0, metrics: 0 };
  const metrics = await locationMetricsChunk(shop, run, input);
  await finishLocationMetrics(shop, run, input.startedAt);
  return { locations: run.planning.length, metrics };
}

/**
 * One location's last sale before the window and first stock day from the stored days (DB scale
 * #3): the last sale is known only when it is older than the window (else undefined, see
 * computeLocation).
 */
function fromStored(days: ReadonlyMap<string, LocationDayRow[]>, ids: readonly string[], locationId: string, from: string) {
  const lastSale = new Map<string, string | null | undefined>();
  const dataSince = new Map<string, string | null>();
  for (const id of ids) {
    const row = days.get(id)?.find((r) => r.locationKey === locationId);
    dataSince.set(id, row?.firstStockDay ?? null);
    lastSale.set(id, storedLastSaleBefore(row?.lastSaleDay ?? null, from));
  }
  return { lastSale, dataSince };
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
  pooled: {
    onlineSold: ReadonlyMap<string, ReadonlyMap<string, number>>;
    shares: ReadonlyMap<string, ReadonlyMap<string, number>>;
    days: ReadonlyMap<string, LocationDayRow[]> | null;
  },
): Promise<number> {
  // Only the planned variants (active, tracked, not bundles), only the rate window (x.range).
  const ids = x.plans.map((p) => p.v.id);
  const view = { channel: ALL, locationKey: locationId };
  const [salesG, stockRows, stored, stockNow] = await Promise.all([
    // Location view only: this location's POS sales.
    chunked(ids, (chunk) =>
      facts.salesDaily.groupBy({
        by: ["variantId", "day"],
        where: { shop, channel: ALL, locationKey: locationId, variantId: { in: chunk }, day: x.range },
        _sum: { sold: true },
      }),
    ),
    chunked(ids, (chunk) =>
      facts.stockDaily.findMany({
        where: { shop, locationId, variantId: { in: chunk }, day: x.range },
        select: { variantId: true, day: true, endUnits: true, outOfStock: true },
      }),
    ),
    // Last sale here before the window, first stock day here: stored days (DB scale #3), else the facts.
    pooled.days ? Promise.resolve(fromStored(pooled.days, ids, locationId, x.from)) : legacyDays(shop, ids, { from: x.from, view, locations: [locationId] }),
    chunked(ids, (chunk) =>
      prisma.stockNow.findMany({ where: { shop, locationId, variantId: { in: chunk } }, select: { variantId: true, onHand: true, available: true, incoming: true } }),
    ),
  ]);

  const sales: SalesDay[] = salesG.map((g) => ({ variantId: g.variantId, day: dayKey(g.day), sold: num(g._sum.sold), gross: 0 }));
  const stock = locationStockDays(stockRows.map((r) => ({ variantId: r.variantId, day: dayKey(r.day), endUnits: r.endUnits, outOfStock: r.outOfStock })));
  const series = buildSeries(sales, stock);
  const lastSale: Map<string, string | null | undefined> = stored.lastSale;
  const dataSince = stored.dataSince;
  const now = new Map(stockNow.map((s) => [s.variantId, s]));
  const carried = carriedAt(now.keys(), new Set(stockRows.map((r) => r.variantId)));

  const ownSold = new Map<string, number>();
  for (const s of sales) ownSold.set(s.variantId, (ownSold.get(s.variantId) ?? 0) + s.sold);
  const fromPool = source === "online_pool";

  // A pool warehouse gets its share of the online demand on the pool's days (see the shared header).
  const seriesOf = (id: string) =>
    fromPool ? shareSeries(x.pool.series.get(id) ?? [], pooled.onlineSold.get(id), pooled.shares.get(id)?.get(locationId) ?? 0) : (series.get(id) ?? []);
  // The last sale before the window where the series has no sale to stand in for it: exact
  // (stored days know only the overall last sale; DB scale #3).
  const unknown = x.plans.filter(({ v }) => carried.has(v.id) && (fromPool ? x.pool.lastSale : lastSale).get(v.id) === undefined && !seriesSold(seriesOf(v.id))).map(({ v }) => v.id);
  if (unknown.length && fromPool) await x.pool.resolveLastSale?.(unknown);
  if (unknown.length && !fromPool) for (const [id, day] of await lastSaleBefore(shop, unknown, x.from, view)) lastSale.set(id, day);

  const results: { r: VariantResult; supplierId: string | null }[] = [];
  for (const { v, supplier } of x.plans) {
    if (!carried.has(v.id)) continue;
    const s = now.get(v.id);
    const season = x.seasonOf.get(v.id);
    const computed = computeVariant({
      id: v.id,
      isBundle: false,
      series: seriesOf(v.id),
      today: x.today,
      onHand: s?.available ?? 0, // planning position: Shopify available (may be negative), not on_hand (audit C2)
      incoming: s?.incoming ?? 0,
      role: x.roles.get(v.id) ?? "C",
      productCreatedAt: v.productCreatedAt ? v.productCreatedAt.toISOString() : null,
      lastSaleDay: (fromPool ? x.pool.lastSale.get(v.id) : lastSale.get(v.id)) ?? null,
      dataSinceDay: (fromPool ? x.pool.dataSince.get(v.id) : dataSince.get(v.id)) ?? null,
      supplierLeadTimeDays: supplier?.leadTimeDays ?? null,
      leadTimeSigmaDays: supplierLeadSigma(supplier),
      cycleDays: supplier?.orderCycleDays ?? null,
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
  // Variants no longer carried here (or no longer planned) lose their row in finishLocationMetrics,
  // once every chunk is written.
  return results.length;
}
