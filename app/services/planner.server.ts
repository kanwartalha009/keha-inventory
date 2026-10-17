/**
 * Planner, data side (spec §5.4, J6; task 2.5). Reads the database only — no Shopify calls,
 * nothing written to the store. The maths is pure (lib/planner-shared).
 *
 * Inputs and why they are consistent with the rest of the app:
 *  - Rate, σ, z and "enough data": the latest VariantMetric run (scope "online"), i.e. the
 *    numbers Products and Reorder show. The planner does not recompute the sales rate.
 *  - Stock: Σ StockNow over the supplier-order pool (compute-shared countsForOnline: every
 *    active location unless the merchant left it out). The PLANNING position is Shopify's
 *    `available` (on hand − committed − reserved …; negative when oversold), as compute;
 *    `onHand` is kept for display. Plus Shopify's incoming and the units on sent / confirmed
 *    Keha orders (supplier-shared onOrderByVariant: remaining units), minus the units compute
 *    estimated as already landed (VariantMetric.inputs.kehaLanded).
 *  - Seasonality and trend: daily units from the pool's demand view (compute-shared demandWhere:
 *    all channels, minus locations left out) — the view the sales rate uses — at store or
 *    collection level (collections that sold ≥ 2,000 units in 12 months), only over the windows
 *    the maths reads (seasonWindows). The trend is applied only when the shop turned the growth
 *    assumption on (settings trendMode, default off), as compute.
 *  - "Last year same period", collection goals and the scorecard's revenue ranking: the
 *    CHANNEL view (locationKey "all", every channel). The two views are never added together.
 */
import prisma from "../db.server";
import { readLandedPct, readPaymentTerms } from "../lib/cash-shared";
import { facts } from "./facts-store.server";
import {
  computeScenario,
  createPlannerSeason,
  effectiveStart,
  lastYearSpan,
  seasonWindows,
  type DayRange,
  type LastYearFigures,
  type PlannerSupplier,
  type PlannerVariant,
  type ScenarioResult,
  type TargetType,
} from "../lib/planner-shared";
import { SEASON, buildSeasonGroups, spanStats, type Coverage, type UnitsSeries } from "../lib/engine/season-shared";
import { productTypeSeriesQuery, readProductTypeSeries, type RawQuery } from "../lib/season-sql-shared";
import { addDays } from "../lib/engine/dates-shared";
import { POOL_LOCATION_SELECT, demandScope, demandWhere, poolLocationIds, salesCoverage, type DemandScope } from "../lib/compute-shared";
import { METRIC_SCOPE } from "../lib/products-shared";
import { OPEN_PO_STATUSES } from "../lib/supplier-shared";
import { readSettings } from "../lib/settings-shared";
import type { TrendMode } from "../lib/engine/season-shared";
import { readBackfillState } from "../lib/sync/backfill-shared";
import { ALL, dayDate } from "../lib/sync/facts-shared";
import { localDate, safeTimeZone } from "../lib/sync/store-time-shared";
import { kehaOnOrder } from "../models/reorder.server";

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const prismaRaw: RawQuery = (sql, params) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};

/** VariantMetric.inputs.kehaLanded (compute): Keha order units estimated to have landed early. */
function landedOf(inputs: Record<string, unknown>): number {
  const v = inputs.kehaLanded;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export type PlannerShop = {
  currency: string;
  timezone: string;
  today: string;
  leadTimeDays: number;
  coverage: Coverage;
  /** Pool demand: the SalesDaily view compute reads (demandWhere; never both views). */
  demand: DemandScope;
  pool: string[];
  /** Growth assumption (settings trendMode); "off" by default. */
  trendMode: TrendMode;
};

/** Store currency, today (store time zone), default lead time, sales coverage and the online pool. */
export async function plannerShop(shop: string, now: Date = new Date()): Promise<PlannerShop> {
  const [row, locations] = await Promise.all([
    prisma.shop.findUnique({ where: { domain: shop }, select: { currency: true, timezone: true, settings: true, backfillState: true } }),
    // The merchant's "counts for online sales" override included (review fix): same pool as compute.
    prisma.location.findMany({ where: { shop }, select: POOL_LOCATION_SELECT }),
  ]);
  const timezone = safeTimeZone(row?.timezone);
  const pool = poolLocationIds(locations);
  const settings = readSettings(row?.settings);
  return {
    currency: row?.currency ?? "USD",
    timezone,
    today: localDate(now, timezone),
    leadTimeDays: settings.leadTimeDays,
    coverage: salesCoverage(readBackfillState(row?.backfillState)),
    demand: demandScope(locations, settings.excludedChannels),
    pool,
    trendMode: settings.trendMode,
  };
}

const rangeWhere = (r: DayRange) => ({ gte: dayDate(r.from), lte: dayDate(r.to) });

/** Variants the planner can plan: the latest VariantMetric (online pool) joined with the catalog and stock. */
async function plannerVariants(shop: string, ctx: PlannerShop): Promise<PlannerVariant[]> {
  const metrics = await prisma.variantMetric.findMany({
    where: { shop, scope: METRIC_SCOPE },
    select: { variantId: true, rate: true, sigma: true, inputs: true },
  });
  if (!metrics.length) return [];
  const ids = metrics.map((m) => m.variantId);
  const [variants, stock, keha] = await Promise.all([
    prisma.variant.findMany({
      where: { shop, tracked: true, isBundle: false, status: "ACTIVE" },
      select: {
        id: true,
        productId: true,
        productTitle: true,
        variantTitle: true,
        sku: true,
        image: true,
        vendor: true,
        supplierId: true,
        collections: true,
        productType: true,
        caseQty: true,
        cost: true,
        costCurrency: true,
        price: true,
      },
    }),
    ctx.pool.length
      ? prisma.stockNow.groupBy({
          by: ["variantId"],
          where: { shop, locationId: { in: ctx.pool } },
          _sum: { onHand: true, available: true, incoming: true },
        })
      : Promise.resolve([] as { variantId: string; _sum: { onHand: number | null; available: number | null; incoming: number | null } }[]),
    kehaOnOrder(shop, OPEN_PO_STATUSES),
  ]);
  const wanted = new Set(ids);
  const stockOf = new Map(stock.map((s) => [s.variantId, s._sum]));
  const metricOf = new Map(metrics.map((m) => [m.variantId, m]));
  const out: PlannerVariant[] = [];
  for (const v of variants) {
    if (!wanted.has(v.id)) continue;
    const m = metricOf.get(v.id)!;
    const inputs = m.inputs && typeof m.inputs === "object" ? (m.inputs as Record<string, unknown>) : {};
    const s = stockOf.get(v.id);
    out.push({
      id: v.id,
      productId: v.productId,
      productTitle: v.productTitle,
      variantTitle: v.variantTitle,
      sku: v.sku,
      image: v.image,
      vendor: v.vendor,
      supplierId: v.supplierId,
      collections: v.collections ?? [],
      productType: v.productType,
      caseQty: v.caseQty,
      cost: num(v.cost),
      costCurrency: v.costCurrency,
      price: num(v.price),
      rate: m.rate,
      sigma: m.sigma,
      z: num(inputs.z),
      enoughData: inputs.enoughData === true,
      onHand: s?.onHand ?? 0,
      // The planning position (Shopify available; negative when oversold), as compute.
      available: s?.available ?? s?.onHand ?? 0,
      // Keha units minus those compute estimated as already landed (they are in on-hand).
      incoming: (s?.incoming ?? 0) + Math.max(0, (keha.get(v.id)?.qty ?? 0) - landedOf(inputs)),
    });
  }
  return out;
}

/**
 * Store and season-group unit series over the windows the period maths reads: qualifying
 * collections from the variant × day sums, every qualifying product type in ONE grouped statement
 * (season-sql-shared; members: the planner's variants, active and tracked).
 */
async function plannerSeason(
  shop: string,
  ctx: PlannerShop,
  input: { start: string; end: string; variants: { id: string; productId: string; collections: string[]; productType?: string | null }[] },
  raw: RawQuery = prismaRaw,
) {
  const { today, coverage } = ctx;
  const yesterday = addDays(today, -1);
  const windows = seasonWindows(today, input.start, input.end);
  const pool = { shop, ...demandWhere(ctx.demand) };
  const [storeG, units12G] = await Promise.all([
    Promise.all(windows.map((r) => facts.salesDaily.groupBy({ by: ["day"], where: { ...pool, day: rangeWhere(r) }, _sum: { sold: true } }))),
    facts.salesDaily.groupBy({
      by: ["variantId"],
      where: { ...pool, day: { gte: dayDate(addDays(today, -SEASON.units12mDays)), lte: dayDate(yesterday) } },
      _sum: { sold: true },
    }),
  ]);
  const storeUnits = new Map<string, number>();
  for (const g of storeG.flat()) storeUnits.set(dayKey(g.day), num(g._sum.sold) ?? 0);

  const variantUnits12 = new Map(units12G.map((g) => [g.variantId, num(g._sum.sold) ?? 0]));
  // The planner's variants are active and tracked: every one counts toward the catalogue.
  const { groups, members } = buildSeasonGroups(
    input.variants.map((v) => ({ id: v.id, productId: v.productId, collections: v.collections, productType: v.productType, counted: true })),
    variantUnits12,
  );
  const qualifying = [...groups.values()].filter((g) => g.qualifies);
  const collections = qualifying.filter((g) => g.kind === "collection");
  const types = qualifying.filter((g) => g.kind === "productType");

  const groupSeries = new Map<string, UnitsSeries>();
  if (collections.length) {
    const rows = (
      await Promise.all(windows.map((r) => facts.salesDaily.groupBy({ by: ["variantId", "day"], where: { ...pool, day: rangeWhere(r) }, _sum: { sold: true } })))
    ).flat();
    const byVariant = new Map<string, Map<string, number>>();
    for (const g of rows) {
      const m = byVariant.get(g.variantId) ?? byVariant.set(g.variantId, new Map()).get(g.variantId)!;
      m.set(dayKey(g.day), num(g._sum.sold) ?? 0);
    }
    for (const c of collections) {
      const units = new Map<string, number>();
      for (const id of members.get(c.id) ?? []) for (const [day, u] of byVariant.get(id) ?? []) units.set(day, (units.get(day) ?? 0) + u);
      groupSeries.set(c.id, { units, coverage });
    }
  }
  const q = productTypeSeriesQuery({ shop, demand: ctx.demand, types: types.map((g) => g.key), windows, plannedOnly: true });
  if (q) {
    const byType = readProductTypeSeries(await raw(q.sql, q.params));
    for (const g of types) groupSeries.set(g.id, { units: byType.get(g.key) ?? new Map(), coverage });
  }
  return createPlannerSeason({ today, start: input.start, end: input.end, store: { units: storeUnits, coverage }, groupSeries, groups, trendMode: ctx.trendMode });
}

/** Units and revenue over the same dates last year (channel view, all channels); null below 80 % coverage. */
async function lastYearFigures(shop: string, ctx: PlannerShop, start: string, end: string): Promise<LastYearFigures> {
  const span = lastYearSpan(ctx.today, effectiveStart(start, ctx.today), end);
  const coverage = spanStats({ units: new Map(), coverage: ctx.coverage }, span.from, span.to).coverage;
  if (coverage < SEASON.minCoverage) return { from: span.from, to: span.to, units: null, revenue: null, coverage };
  const days = await facts.salesDaily.groupBy({
    by: ["day"],
    where: { shop, locationKey: ALL, day: { gte: dayDate(span.from), lte: dayDate(span.to) } },
    _sum: { sold: true, gross: true },
  });
  const units = days.reduce((a, d) => a + (num(d._sum.sold) ?? 0), 0);
  const revenue = days.reduce((a, d) => a + (num(d._sum.gross) ?? 0), 0);
  return { from: span.from, to: span.to, units, revenue: Math.round(revenue * 100) / 100, coverage };
}

export type ScenarioSpec = { start: string; end: string; targetType: TargetType; targetValue: number };

/** Computes one scenario from the database. */
export async function computeScenarioFor(shop: string, spec: ScenarioSpec, now: Date = new Date()): Promise<ScenarioResult> {
  const ctx = await plannerShop(shop, now);
  const [variants, suppliers] = await Promise.all([
    plannerVariants(shop, ctx),
    prisma.supplier.findMany({
      where: { shop },
      select: {
        id: true,
        name: true,
        leadTimeDays: true,
        minOrder: true,
        minOrderTotal: true,
        casePack: true,
        vendorMatch: true,
        currency: true,
        exchangeRate: true,
        transitDays: true,
        // Payment terms and freight & duty: the Season plan's cash follows the same model as Next 13 weeks.
        depositPercent: true,
        balanceDue: true,
        balanceDays: true,
        landedCostPercent: true,
      },
    }),
  ]);
  const [season, lastYear] = await Promise.all([
    plannerSeason(shop, ctx, { start: spec.start, end: spec.end, variants }),
    lastYearFigures(shop, ctx, spec.start, spec.end),
  ]);
  return computeScenario({
    today: ctx.today,
    start: spec.start,
    end: spec.end,
    targetType: spec.targetType,
    targetValue: spec.targetValue,
    currency: ctx.currency,
    defaultLeadTimeDays: ctx.leadTimeDays,
    variants,
    suppliers: suppliers.map(
      (x): PlannerSupplier => ({
        id: x.id,
        name: x.name,
        leadTimeDays: x.leadTimeDays,
        minOrder: x.minOrder,
        minOrderTotal: x.minOrderTotal,
        casePack: x.casePack,
        vendorMatch: x.vendorMatch,
        currency: x.currency,
        exchangeRate: x.exchangeRate === null || x.exchangeRate === undefined ? null : Number(String(x.exchangeRate)),
        transitDays: x.transitDays ?? null,
        terms: readPaymentTerms(x),
        landedPct: readLandedPct(x.landedCostPercent),
      }),
    ),
    season,
    coverage: ctx.coverage,
    lastYear,
    computedAt: now.toISOString(),
  });
}
