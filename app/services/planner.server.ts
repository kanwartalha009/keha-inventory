/**
 * Planner, data side (spec §5.4, J6; task 2.5). Reads the database only — no Shopify calls,
 * nothing written to the store. The maths is pure (lib/planner-shared).
 *
 * Inputs and why they are consistent with the rest of the app:
 *  - Rate, σ, z and "enough data": the latest VariantMetric run (scope "online"), i.e. the
 *    numbers Products and Reorder show. The planner does not recompute the sales rate.
 *  - Stock: Σ StockNow over the online pool (onHand, Shopify's incoming) plus units on sent /
 *    confirmed Keha orders (they never reach Shopify; compute counts them the same way).
 *  - Seasonality and trend: daily units from the SalesDaily LOCATION view (channel "all",
 *    locationKey in the pool keys) — the view the sales rate uses — at store or collection
 *    level (collections that sold ≥ 2,000 units in 12 months), only over the windows the maths
 *    reads (seasonWindows).
 *  - "Last year same period", collection goals and the scorecard's revenue ranking: the
 *    CHANNEL view (locationKey "all", every channel). The two views are never added together.
 */
import prisma from "../db.server";
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
import { SEASON, spanStats, type Coverage, type UnitsSeries } from "../lib/engine/season-shared";
import { addDays } from "../lib/engine/dates-shared";
import { poolLocationIds, poolSalesKeys, salesCoverage } from "../lib/compute-shared";
import { METRIC_SCOPE } from "../lib/products-shared";
import { OPEN_PO_STATUSES } from "../lib/supplier-shared";
import { readSettings } from "../lib/settings-shared";
import { readBackfillState } from "../lib/sync/backfill-shared";
import { ALL, dayDate } from "../lib/sync/facts-shared";
import { localDate, safeTimeZone } from "../lib/sync/store-time-shared";
import { kehaOnOrder } from "../models/reorder.server";

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};

export type PlannerShop = {
  currency: string;
  timezone: string;
  today: string;
  leadTimeDays: number;
  coverage: Coverage;
  poolKeys: string[];
  pool: string[];
};

/** Store currency, today (store time zone), default lead time, sales coverage and the online pool. */
export async function plannerShop(shop: string, now: Date = new Date()): Promise<PlannerShop> {
  const [row, locations] = await Promise.all([
    prisma.shop.findUnique({ where: { domain: shop }, select: { currency: true, timezone: true, settings: true, backfillState: true } }),
    prisma.location.findMany({ where: { shop }, select: { id: true, active: true, online: true } }),
  ]);
  const timezone = safeTimeZone(row?.timezone);
  const pool = poolLocationIds(locations);
  return {
    currency: row?.currency ?? "USD",
    timezone,
    today: localDate(now, timezone),
    leadTimeDays: readSettings(row?.settings).leadTimeDays,
    coverage: salesCoverage(readBackfillState(row?.backfillState)),
    poolKeys: poolSalesKeys(pool),
    pool,
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
          _sum: { onHand: true, incoming: true },
        })
      : Promise.resolve([] as { variantId: string; _sum: { onHand: number | null; incoming: number | null } }[]),
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
      caseQty: v.caseQty,
      cost: num(v.cost),
      costCurrency: v.costCurrency,
      price: num(v.price),
      rate: m.rate,
      sigma: m.sigma,
      z: num(inputs.z),
      enoughData: inputs.enoughData === true,
      onHand: s?.onHand ?? 0,
      incoming: (s?.incoming ?? 0) + (keha.get(v.id)?.qty ?? 0),
    });
  }
  return out;
}

/** Store and collection unit series over the windows the period maths reads. */
async function plannerSeason(
  shop: string,
  ctx: PlannerShop,
  input: { start: string; end: string; variants: { id: string; collections: string[] }[] },
) {
  const { today, poolKeys, coverage } = ctx;
  const yesterday = addDays(today, -1);
  const windows = seasonWindows(today, input.start, input.end);
  const pool = { shop, channel: ALL, locationKey: { in: poolKeys } };
  const [storeG, units12G] = await Promise.all([
    Promise.all(windows.map((r) => prisma.salesDaily.groupBy({ by: ["day"], where: { ...pool, day: rangeWhere(r) }, _sum: { sold: true } }))),
    prisma.salesDaily.groupBy({
      by: ["variantId"],
      where: { ...pool, day: { gte: dayDate(addDays(today, -SEASON.units12mDays)), lte: dayDate(yesterday) } },
      _sum: { sold: true },
    }),
  ]);
  const storeUnits = new Map<string, number>();
  for (const g of storeG.flat()) storeUnits.set(dayKey(g.day), num(g._sum.sold) ?? 0);

  const variantUnits12 = new Map(units12G.map((g) => [g.variantId, num(g._sum.sold) ?? 0]));
  const members = new Map<string, string[]>();
  for (const v of input.variants) for (const c of new Set(v.collections)) (members.get(c) ?? members.set(c, []).get(c)!).push(v.id);
  const units12m = new Map<string, number>();
  for (const [c, vs] of members) units12m.set(c, vs.reduce((a, id) => a + (variantUnits12.get(id) ?? 0), 0));
  const qualifying = [...units12m].filter(([, u]) => u >= SEASON.collectionMinUnits12m).map(([c]) => c);

  const collections = new Map<string, UnitsSeries>();
  if (qualifying.length) {
    const rows = (
      await Promise.all(windows.map((r) => prisma.salesDaily.groupBy({ by: ["variantId", "day"], where: { ...pool, day: rangeWhere(r) }, _sum: { sold: true } })))
    ).flat();
    const byVariant = new Map<string, Map<string, number>>();
    for (const g of rows) {
      const m = byVariant.get(g.variantId) ?? byVariant.set(g.variantId, new Map()).get(g.variantId)!;
      m.set(dayKey(g.day), num(g._sum.sold) ?? 0);
    }
    for (const c of qualifying) {
      const units = new Map<string, number>();
      for (const id of members.get(c) ?? []) for (const [day, u] of byVariant.get(id) ?? []) units.set(day, (units.get(day) ?? 0) + u);
      collections.set(c, { units, coverage });
    }
  }
  return createPlannerSeason({ today, start: input.start, end: input.end, store: { units: storeUnits, coverage }, collections, units12m });
}

/** Units and revenue over the same dates last year (channel view, all channels); null below 80 % coverage. */
async function lastYearFigures(shop: string, ctx: PlannerShop, start: string, end: string): Promise<LastYearFigures> {
  const span = lastYearSpan(ctx.today, effectiveStart(start, ctx.today), end);
  const coverage = spanStats({ units: new Map(), coverage: ctx.coverage }, span.from, span.to).coverage;
  if (coverage < SEASON.minCoverage) return { from: span.from, to: span.to, units: null, revenue: null, coverage };
  const days = await prisma.salesDaily.groupBy({
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
      select: { id: true, name: true, leadTimeDays: true, minOrder: true, minOrderTotal: true, casePack: true, vendorMatch: true, currency: true },
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
    suppliers: suppliers as PlannerSupplier[],
    season,
    coverage: ctx.coverage,
    lastYear,
    computedAt: now.toISOString(),
  });
}
