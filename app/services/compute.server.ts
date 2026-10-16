/**
 * Compute (spec §6.6 "compute", §7; task 1.5): the engine over stored facts →
 * VariantMetric (scope "online") and MoneyAtStake (today, store-local).
 *
 * Reads only the database (no Shopify calls). Phase 1 pooling rule: see compute-shared.
 * Bundles and untracked variants are skipped. VariantMetric is refreshed on every run;
 * money on the Free plan only when the last MoneyAtStake row is from an earlier calendar
 * month (MONEY_REFRESH), daily otherwise. Seasonal / trend / plan multipliers are 1 this
 * phase (§7.3 lands in task 2.1).
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
  type VariantResult,
} from "../lib/engine/index-shared";
import {
  SCOPE_ONLINE,
  buildSeries,
  engineSettingsFrom,
  metricRow,
  moneyDue,
  poolLocationIds,
  productTraffic,
  revenueOf,
  sessionsByHandle,
  storeConversion,
  type PooledStockDay,
  type SalesDay,
  type TrafficProduct,
} from "../lib/compute-shared";
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
    select: { timezone: true, currency: true, settings: true, uninstalledAt: true },
  });
  if (!shopRow || shopRow.uninstalledAt) return { status: "skipped" };
  const tz = safeTimeZone(shopRow.timezone);
  const today = localDate(startedAt, tz);
  const from = addDays(today, -HISTORY_DAYS);
  const to = addDays(today, -1);
  const range = { gte: dayDate(from), lte: dayDate(to) };

  const overrides = engineSettingsFrom(readSettings(shopRow.settings));
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
        tracked: true,
        isBundle: true,
        cost: true,
        price: true,
        productCreatedAt: true,
        caseQty: true,
        supplierId: true,
      },
    }),
    prisma.supplier.findMany({ where: { shop }, select: { id: true, leadTimeDays: true, minOrder: true } }),
  ]);
  const pool = poolLocationIds(locations);
  const considered = variants.filter((v) => v.tracked && !v.isBundle);
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));

  // ---- facts (grouped in SQL) ----
  const [salesG, stockG, outG, lastSaleG, stockNow] = await Promise.all([
    prisma.salesDaily.groupBy({
      by: ["variantId", "day"],
      where: { shop, locationKey: ALL, day: range },
      _sum: { sold: true, gross: true },
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
      where: { shop, locationKey: ALL, sold: { gt: 0 }, day: { lt: dayDate(from) } },
      _max: { day: true },
    }),
    pool.length
      ? prisma.stockNow.findMany({
          where: { shop, locationId: { in: pool } },
          select: { variantId: true, onHand: true, incoming: true },
        })
      : Promise.resolve([]),
  ]);

  const sales: SalesDay[] = salesG.map((g) => ({
    variantId: g.variantId,
    day: dayKey(g.day),
    sold: num(g._sum.sold),
    gross: num(g._sum.gross),
  }));
  const outCount = new Map(outG.map((g) => [`${g.variantId}|${dayKey(g.day)}`, g._count._all]));
  const stock: PooledStockDay[] = stockG.map((g) => ({
    variantId: g.variantId,
    day: dayKey(g.day),
    endUnits: num(g._sum.endUnits),
    reported: g._count._all,
    outReported: outCount.get(`${g.variantId}|${dayKey(g.day)}`) ?? 0,
  }));
  const series = buildSeries(sales, stock);
  const revenue = revenueOf(sales);
  const lastSale = new Map(lastSaleG.map((g) => [g.variantId, g._max.day ? dayKey(g._max.day) : null]));
  const onHand = new Map<string, { onHand: number; incoming: number }>();
  for (const s of stockNow) {
    const cur = onHand.get(s.variantId) ?? { onHand: 0, incoming: 0 };
    cur.onHand += s.onHand;
    cur.incoming += s.incoming;
    onHand.set(s.variantId, cur);
  }

  // ---- engine ----
  const roles = abcRoles(
    considered.map((v) => ({ id: v.id, revenue90: revenue.get(v.id) ?? 0 })),
    settings,
  );
  const results: VariantResult[] = [];
  for (const v of considered) {
    const supplier = v.supplierId ? supplierById.get(v.supplierId) : undefined;
    const stockNowRow = onHand.get(v.id) ?? { onHand: 0, incoming: 0 };
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
      supplierLeadTimeDays: supplier?.leadTimeDays ?? null,
      caseQty: v.caseQty,
      minOrder: supplier?.minOrder ?? null,
      seasonal: 1,
      trend: 1,
      plan: 1,
      price: numOrNull(v.price),
      cost: numOrNull(v.cost),
      settings: overrides,
    });
    if (r) results.push(r);
  }

  for (let i = 0; i < results.length; i += WRITE_BATCH) {
    const batch = results.slice(i, i + WRITE_BATCH);
    await prisma.$transaction(
      batch.map((r) => {
        const m = metricRow(r);
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
    return { landingPath: g.landingPath, day: dayKey(g.day), sessions: num(g._sum.sessions) };
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
  return { status: "computed", today, variants: results.length, money: "computed" };
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
