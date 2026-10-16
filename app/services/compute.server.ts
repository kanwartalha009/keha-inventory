/**
 * Compute (spec §6.6 "compute", §7; task 1.5): the engine over stored facts →
 * VariantMetric (scope "online") and MoneyAtStake (today, store-local).
 *
 * Reads only the database (no Shopify calls). Phase 1 pooling rule: see compute-shared.
 * Only ACTIVE products' tracked, non-bundle variants are computed; DRAFT / ARCHIVED products
 * get no VariantMetric (stale rows are removed) and never reach the money cards. VariantMetric is refreshed on every run;
 * money on the Free plan only when the last MoneyAtStake row is from an earlier calendar
 * month (MONEY_REFRESH), daily otherwise.
 *
 * Task 2.1 / 2.4:
 *  - seasonal × trend (§7.3, season.server + engine/season-shared) per variant, for the horizon
 *    lead time + cycle, at store or collection level; the plan multiplier stays 1 (the planner
 *    applies its own). Everything behind them goes into VariantMetric.inputs.
 *  - supplier per variant: supplierFor() (explicit, then vendor match); its lead time and per-line
 *    minimum order; case pack: casePackFor(). The order-total minimum is the Reorder screen's.
 *  - safety level → z per ABC role (engineSettingsFrom).
 *  - the action list (§7.7, engine/actions-rules-shared) is written with the money cards, on the
 *    same cadence (Free: monthly, paid: daily), so Free's € figures refresh monthly everywhere.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import {
  abcRoles,
  cashStuck,
  computeVariant,
  resolveSettings,
  salesAtRisk,
  salesLostToSellOuts,
  soldOutPageTraffic,
  type DailyRow,
  type EngineSettings,
  type VariantResult,
} from "../lib/engine/index-shared";
import type { StoreConversion } from "../lib/engine/money-shared";
import {
  SCOPE_ONLINE,
  buildSeries,
  engineSettingsFrom,
  planActionWrites,
  poArrivals,
  poolSalesKeys,
  metricRow,
  moneyDue,
  poolLocationIds,
  productHandleFromPath,
  productTraffic,
  revenueOf,
  salesCoverage,
  sessionsByHandle,
  soldOver,
  storeConversion,
  type PooledStockDay,
  type SalesDay,
  type TrafficProduct,
} from "../lib/compute-shared";
import { generateActions, type RuleProduct, type RuleVariant } from "../lib/engine/actions-rules-shared";
import { resolveLeadTime } from "../lib/engine/order-shared";
import { SEASON, seasonFacts, spanStats, type Coverage, type VariantSeason } from "../lib/engine/season-shared";
import { serviceLevelFor } from "../lib/engine/safety-shared";
import { OPEN_PO_STATUSES, casePackFor, poArrival, readPoLines, supplierFor } from "../lib/supplier-shared";
import { readBackfillState } from "../lib/sync/backfill-shared";
import { loadSeasonContext } from "./season.server";
import { readSettings } from "../lib/settings-shared";
import { MONEY_REFRESH, type PlanCode } from "../lib/plan-shared";
import type { MoneyBasisJson } from "../lib/money-shared";
import { ALL, dayDate } from "../lib/sync/facts-shared";
import { localDate, safeTimeZone } from "../lib/sync/store-time-shared";
import { addDays } from "../lib/sync/shopifyql-shared";
import { planFor } from "./entitlements.server";

const HISTORY_DAYS = 90;
const TRAFFIC_DAYS = 30;
const WRITE_BATCH = 200;

export type ComputeResult = {
  status: "computed" | "skipped";
  today?: string;
  variants?: number;
  money?: "computed" | "not_due";
  /** Actions written (with the money cards; absent when money was not due). */
  actions?: number;
};

export type ComputeOptions = { now?: () => number; plan?: (shop: string) => Promise<PlanCode> };

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function computeShop(shop: string, opts: ComputeOptions = {}): Promise<ComputeResult> {
  const now = opts.now ?? Date.now;
  const startedAt = new Date(now());
  const shopRow = await prisma.shop.findUnique({
    where: { domain: shop },
    select: { timezone: true, currency: true, settings: true, uninstalledAt: true, backfillState: true },
  });
  if (!shopRow || shopRow.uninstalledAt) return { status: "skipped" };
  const tz = safeTimeZone(shopRow.timezone);
  const today = localDate(startedAt, tz);
  const from = addDays(today, -HISTORY_DAYS);
  const to = addDays(today, -1);
  const range = { gte: dayDate(from), lte: dayDate(to) };

  const shopSettings = readSettings(shopRow.settings);
  const overrides = engineSettingsFrom(shopSettings);
  const settings = resolveSettings(overrides);

  // ---- catalog and pool ----
  const [locations, variants, suppliers] = await Promise.all([
    prisma.location.findMany({ where: { shop }, select: { id: true, active: true, online: true } }),
    prisma.variant.findMany({
      where: { shop },
      select: {
        id: true,
        productId: true,
        handle: true,
        vendor: true,
        collections: true,
        tracked: true,
        isBundle: true,
        cost: true,
        price: true,
        productCreatedAt: true,
        caseQty: true,
        supplierId: true,
        status: true,
      },
    }),
    prisma.supplier.findMany({
      where: { shop },
      select: { id: true, name: true, leadTimeDays: true, minOrder: true, minOrderTotal: true, casePack: true, vendorMatch: true },
    }),
  ]);
  const pool = poolLocationIds(locations);
  const considered = variants.filter((v) => v.tracked && !v.isBundle && v.status === "ACTIVE");
  const poolKeys = poolSalesKeys(pool);

  // ---- facts (grouped in SQL) ----
  const [channelG, poolSalesG, stockG, outG, lastSaleG, dataSinceG, stockNow] = await Promise.all([
    // Channel view: revenue (ABC), unit price and returns only.
    prisma.salesDaily.groupBy({
      by: ["variantId", "day"],
      where: { shop, locationKey: ALL, day: range },
      _sum: { sold: true, gross: true, returned: true },
    }),
    // Location view, online + pool locations: units sold for the online pool.
    prisma.salesDaily.groupBy({
      by: ["variantId", "day"],
      where: { shop, channel: ALL, locationKey: { in: poolKeys }, day: range },
      _sum: { sold: true },
    }),
    pool.length
      ? prisma.stockDaily.groupBy({
          by: ["variantId", "day"],
          where: { shop, locationId: { in: pool }, day: range },
          _sum: { endUnits: true },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    pool.length
      ? prisma.stockDaily.groupBy({
          by: ["variantId", "day"],
          where: { shop, locationId: { in: pool }, day: range, outOfStock: true },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    prisma.salesDaily.groupBy({
      by: ["variantId"],
      where: { shop, channel: ALL, locationKey: { in: poolKeys }, sold: { gt: 0 }, day: { lt: dayDate(from) } },
      _max: { day: true },
    }),
    // Oldest pool stock day per variant: start of the no-sale period for never-sold variants.
    pool.length
      ? prisma.stockDaily.groupBy({
          by: ["variantId"],
          where: { shop, locationId: { in: pool } },
          _min: { day: true },
        })
      : Promise.resolve([]),
    pool.length
      ? prisma.stockNow.findMany({
          where: { shop, locationId: { in: pool } },
          select: { variantId: true, onHand: true, incoming: true },
        })
      : Promise.resolve([]),
  ]);

  const channelSales: SalesDay[] = channelG.map((g) => ({
    variantId: g.variantId,
    day: dayKey(g.day),
    sold: num(g._sum.sold),
    gross: num(g._sum.gross),
  }));
  // Returns over the 90 days (channel view). quantity_returned's sign is unverified: use |x|.
  const returnsByVariant = new Map<string, { sold: number; returned: number }>();
  for (const g of channelG) {
    const cur = returnsByVariant.get(g.variantId) ?? { sold: 0, returned: 0 };
    cur.sold += num(g._sum.sold);
    cur.returned += Math.abs(num(g._sum.returned));
    returnsByVariant.set(g.variantId, cur);
  }
  const poolSales: SalesDay[] = poolSalesG.map((g) => ({
    variantId: g.variantId,
    day: dayKey(g.day),
    sold: num(g._sum.sold),
    gross: 0,
  }));
  const outCount = new Map(outG.map((g) => [`${g.variantId}|${dayKey(g.day)}`, g._count._all]));
  const stock: PooledStockDay[] = stockG.map((g) => ({
    variantId: g.variantId,
    day: dayKey(g.day),
    endUnits: num(g._sum.endUnits),
    reported: g._count._all,
    outReported: outCount.get(`${g.variantId}|${dayKey(g.day)}`) ?? 0,
  }));
  const series = buildSeries(poolSales, stock, channelSales);
  const revenue = revenueOf(channelSales);
  const dataSince = new Map(dataSinceG.map((g) => [g.variantId, g._min.day ? dayKey(g._min.day) : null]));
  const lastSale = new Map(lastSaleG.map((g) => [g.variantId, g._max.day ? dayKey(g._max.day) : null]));
  const onHand = new Map<string, { onHand: number; incoming: number }>();
  for (const s of stockNow) {
    const cur = onHand.get(s.variantId) ?? { onHand: 0, incoming: 0 };
    cur.onHand += s.onHand;
    cur.incoming += s.incoming;
    onHand.set(s.variantId, cur);
  }

  // ---- seasonality and trend (§7.3) ----
  const coverage = salesCoverage(readBackfillState(shopRow.backfillState));
  const plans = considered.map((v) => {
    const supplier = supplierFor(v, suppliers);
    const lead = resolveLeadTime(supplier?.leadTimeDays ?? null, settings);
    return { v, supplier, horizon: lead.days + settings.cycleDays };
  });
  const seasonCtx = await loadSeasonContext(shop, {
    today,
    poolKeys,
    variants: variants.filter((v) => !v.isBundle).map((v) => ({ id: v.id, collections: v.collections ?? [] })),
    coverage,
    maxHorizonDays: plans.reduce((m, p) => Math.max(m, p.horizon), 1),
  });

  // ---- engine ----
  const roles = abcRoles(
    considered.map((v) => ({ id: v.id, revenue90: revenue.get(v.id) ?? 0 })),
    settings,
  );
  const results: VariantResult[] = [];
  const seasonOf = new Map<string, VariantSeason>();
  for (const { v, supplier, horizon } of plans) {
    const stockNowRow = onHand.get(v.id) ?? { onHand: 0, incoming: 0 };
    const season = seasonCtx.forVariant(v.collections ?? [], horizon);
    seasonOf.set(v.id, season);
    const r = computeVariant({
      id: v.id,
      isBundle: false,
      series: series.get(v.id) ?? [],
      today,
      onHand: stockNowRow.onHand,
      incoming: stockNowRow.incoming,
      role: roles.get(v.id) ?? "C",
      productCreatedAt: v.productCreatedAt ? v.productCreatedAt.toISOString() : null,
      lastSaleDay: lastSale.get(v.id) ?? null,
      dataSinceDay: dataSince.get(v.id) ?? null,
      supplierLeadTimeDays: supplier?.leadTimeDays ?? null,
      caseQty: casePackFor(v.caseQty, supplier),
      minOrder: supplier?.minOrder ?? null,
      seasonal: season.seasonal,
      trend: season.trend,
      plan: 1,
      price: numOrNull(v.price),
      cost: numOrNull(v.cost),
      settings: overrides,
    });
    if (r) results.push(r);
  }

  const supplierIdOf = new Map(plans.map((p) => [p.v.id, p.supplier?.id ?? null]));
  for (let i = 0; i < results.length; i += WRITE_BATCH) {
    const batch = results.slice(i, i + WRITE_BATCH);
    await prisma.$transaction(
      batch.map((r) => {
        const season = seasonOf.get(r.id);
        const m = metricRow(r, {
          season: season ? seasonFacts(season) : null,
          safetyLevel: shopSettings.safetyLevel,
          serviceLevel: serviceLevelFor(shopSettings.safetyLevel, r.role),
          supplierId: supplierIdOf.get(r.id) ?? null,
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
          computedAt: startedAt,
          inputs: m.inputs as Prisma.InputJsonValue,
        };
        return prisma.variantMetric.upsert({
          where: { shop_variantId_scope: { shop, variantId: r.id, scope: SCOPE_ONLINE } },
          create: { shop, variantId: r.id, scope: SCOPE_ONLINE, ...data },
          update: data,
        });
      }),
    );
  }
  // Variants no longer tracked / no longer in the catalog lose their metric.
  await prisma.variantMetric.deleteMany({ where: { shop, scope: SCOPE_ONLINE, computedAt: { lt: startedAt } } });

  // ---- money at stake ----
  let plan: PlanCode;
  try {
    plan = await (opts.plan ?? planFor)(shop);
  } catch {
    plan = "pro"; // plan checks fail open (I-6)
  }
  const refresh = MONEY_REFRESH[plan];
  const last = await prisma.moneyAtStake.findFirst({ where: { shop }, orderBy: { day: "desc" }, select: { day: true } });
  if (!moneyDue(refresh, last ? dayKey(last.day) : null, today)) {
    return { status: "computed", today, variants: results.length, money: "not_due" };
  }

  const trafficFrom = addDays(today, -TRAFFIC_DAYS);
  const trafficRange = { gte: dayDate(trafficFrom), lte: dayDate(to) };
  const [sessionsG, shopDays] = await Promise.all([
    prisma.sessionsDaily.groupBy({
      by: ["landingPath", "day"],
      where: { shop, day: trafficRange },
      _sum: { sessions: true, checkouts: true },
    }),
    prisma.shopDaily.findMany({ where: { shop, day: trafficRange }, select: { orders: true, gross: true } }),
  ]);
  const totals = { sessions: 0, checkouts: 0, orders: 0, gross: 0 };
  const landing = sessionsG.map((g) => {
    totals.sessions += num(g._sum.sessions);
    totals.checkouts += num(g._sum.checkouts);
    return { landingPath: g.landingPath, day: dayKey(g.day), sessions: num(g._sum.sessions), checkouts: num(g._sum.checkouts) };
  });
  for (const d of shopDays) {
    totals.orders += d.orders;
    totals.gross += num(d.gross);
  }
  const products = new Map<string, TrafficProduct>();
  for (const v of considered) {
    const p = products.get(v.productId) ?? { productId: v.productId, handle: v.handle, variantIds: [] };
    p.variantIds.push(v.id);
    products.set(v.productId, p);
  }

  const ctx = { today, currency: shopRow.currency, settings };
  const atRisk = salesAtRisk(results, ctx);
  const lost90 = salesLostToSellOuts(results, ctx);
  const stuck = cashStuck(results, ctx);
  const traffic = soldOutPageTraffic(
    productTraffic([...products.values()], series, sessionsByHandle(landing), trafficFrom, to),
    storeConversion(totals),
    ctx,
  );
  const basis: MoneyBasisJson = {
    computedAt: startedAt.toISOString(),
    currency: shopRow.currency,
    refresh,
    atRisk: atRisk.basis,
    lost90: lost90.basis,
    cashStuck: stuck.basis,
    soldOutTraffic: traffic.basis,
  };
  const money = {
    atRisk: atRisk.amount,
    lost90: lost90.amount,
    cashStuck: stuck.amount,
    soldOutTraffic: traffic.amount,
    basis: basis as unknown as Prisma.InputJsonValue,
  };
  await prisma.moneyAtStake.upsert({
    where: { shop_day: { shop, day: dayDate(today) } },
    create: { shop, day: dayDate(today), ...money },
    update: money,
  });

  // ---- action list (§7.7), same cadence as the money cards ----
  const actions = await writeActions(shop, {
    today,
    currency: shopRow.currency,
    settings,
    coverage,
    results,
    considered,
    series,
    channelSales,
    returnsByVariant,
    landing,
    store: storeConversion(totals),
  });
  return { status: "computed", today, variants: results.length, money: "computed", actions };
}

const ACTION_WINDOW = 28;

/** Builds the rule inputs, runs generateActions and persists the result (planActionWrites). */
async function writeActions(
  shop: string,
  x: {
    today: string;
    currency: string;
    settings: EngineSettings;
    coverage: Coverage;
    results: VariantResult[];
    considered: { id: string; productId: string; handle: string }[];
    series: Map<string, DailyRow[]>;
    channelSales: SalesDay[];
    returnsByVariant: Map<string, { sold: number; returned: number }>;
    landing: { landingPath: string; day: string; sessions: number; checkouts: number }[];
    store: StoreConversion;
  },
): Promise<number> {
  const { today } = x;
  const from28 = addDays(today, -ACTION_WINDOW);
  // Same 28 days last year, weekdays aligned (as the trend).
  const lyFrom = addDays(from28, -SEASON.trendShiftDays);
  const lyTo = addDays(today, -1 - SEASON.trendShiftDays);
  const lyCovered = spanStats({ units: new Map(), coverage: x.coverage }, lyFrom, lyTo).coverage >= SEASON.minCoverage;
  const [lyG, pos] = await Promise.all([
    lyCovered
      ? prisma.salesDaily.groupBy({
          by: ["variantId"],
          where: { shop, locationKey: ALL, day: { gte: dayDate(lyFrom), lte: dayDate(lyTo) } },
          _sum: { gross: true },
        })
      : Promise.resolve([]),
    prisma.purchaseOrder.findMany({
      where: { shop, status: { in: [...OPEN_PO_STATUSES] } },
      select: { lines: true, confirmedShipDate: true, expectedDate: true },
    }),
  ]);
  const lyRevenue = new Map(lyG.map((g) => [g.variantId, num(g._sum.gross)]));
  const tyRevenue = new Map<string, number>();
  for (const s of x.channelSales) if (s.day >= from28) tyRevenue.set(s.variantId, (tyRevenue.get(s.variantId) ?? 0) + s.gross);
  const arrivals = poArrivals(
    pos.map((po) => {
      const a = poArrival(po);
      return { lines: readPoLines(po.lines), arrival: a ? dayKey(a) : null };
    }),
  );
  const landingBy = new Map<string, { sessions: number; checkouts: number }>();
  for (const l of x.landing) {
    if (l.day < from28) continue;
    const h = productHandleFromPath(l.landingPath);
    if (!h) continue;
    const cur = landingBy.get(h) ?? { sessions: 0, checkouts: 0 };
    cur.sessions += l.sessions;
    cur.checkouts += l.checkouts;
    landingBy.set(h, cur);
  }
  const haveSessions = x.landing.length > 0;

  const resultOf = new Map(x.results.map((r) => [r.id, r]));
  const products = new Map<string, RuleProduct & { handle: string }>();
  for (const v of x.considered) {
    const r = resultOf.get(v.id);
    if (!r) continue;
    const p =
      products.get(v.productId) ??
      products.set(v.productId, { productId: v.productId, handle: v.handle, variants: [], sessions28: null, checkouts28: null, revenue28: null, revenue28LastYear: null }).get(v.productId)!;
    const ret = x.returnsByVariant.get(v.id);
    const arr = arrivals.get(v.id);
    const rv: RuleVariant = {
      id: v.id,
      status: r.status,
      role: r.role,
      rate: r.rate,
      seasonal: r.seasonal,
      trend: r.trend,
      onHand: r.onHand,
      incoming: r.incoming,
      daysLeft: r.daysLeft,
      orderBy: r.orderBy,
      orderQty: r.orderQty,
      leadTimeDays: r.inputs.leadTimeDays,
      price: r.price,
      cost: r.cost,
      sold28: soldOver(x.series.get(v.id), today, ACTION_WINDOW),
      noSaleDays: r.inputs.noSaleDays,
      arrival: arr?.arrival ?? null,
      incomingDated: arr?.units ?? 0,
      soldNet90: ret ? ret.sold : null,
      returned90: ret ? ret.returned : null,
    };
    p.variants.push(rv);
    p.revenue28 = (p.revenue28 ?? 0) + (tyRevenue.get(v.id) ?? 0);
    if (lyCovered) p.revenue28LastYear = (p.revenue28LastYear ?? 0) + (lyRevenue.get(v.id) ?? 0);
  }
  for (const p of products.values()) {
    const l = landingBy.get(p.handle.toLowerCase());
    p.sessions28 = haveSessions ? (l?.sessions ?? 0) : null;
    p.checkouts28 = haveSessions ? (l?.checkouts ?? 0) : null;
  }
  const returnsMeasured = [...x.returnsByVariant.values()].some((r) => r.returned !== 0);
  const drafts = generateActions([...products.values()], {
    today,
    settings: x.settings,
    aov: x.store.aov,
    returnsMeasured,
  });

  const existing = await prisma.action.findMany({ where: { shop }, select: { dedupeKey: true, state: true } });
  const plan = planActionWrites(existing, drafts);
  for (let i = 0; i < plan.upserts.length; i += WRITE_BATCH) {
    await prisma.$transaction(
      plan.upserts.slice(i, i + WRITE_BATCH).map((d) => {
        const data = {
          kind: d.kind,
          productId: d.productId,
          variantIds: d.variantIds,
          amount: d.amount,
          currency: x.currency,
          reason: d.reason as unknown as Prisma.InputJsonValue,
        };
        return prisma.action.upsert({
          where: { shop_dedupeKey: { shop, dedupeKey: d.dedupeKey } },
          create: { shop, dedupeKey: d.dedupeKey, state: "open", ...data },
          update: data,
        });
      }),
    );
  }
  // Re-checks state "open" in the delete itself: a row snoozed meanwhile is kept.
  for (let i = 0; i < plan.deleteKeys.length; i += WRITE_BATCH) {
    await prisma.action.deleteMany({ where: { shop, state: "open", dedupeKey: { in: plan.deleteKeys.slice(i, i + WRITE_BATCH) } } });
  }
  return plan.upserts.length;
}

/** afterSync hook for the backfill / nightly jobs: compute and log. Never throws. */
export async function computeAfterSync(shop: string): Promise<void> {
  try {
    const r = await computeShop(shop);
    console.log(`[compute] ${shop}: ${r.status}${r.variants !== undefined ? `, ${r.variants} variant(s), money ${r.money}` : ""}`);
  } catch (e) {
    console.error(`[compute] ${shop} failed`, e);
  }
}
