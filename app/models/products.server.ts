/**
 * Products table and variant detail (spec §5.2). Database reads only; the
 * mapping lives in app/lib/products-shared.ts. Everything here uses the same
 * online stock pool as compute (VariantMetric scope "online"): stock now,
 * incoming and sold-out days come from active locations that fulfil online
 * orders, so a row can't read "Stock now 40 · Out".
 *
 * SalesDaily holds two views of the same sales (facts-shared): by location
 * (channel "all") and by channel (locationKey "all"). Totals read the channel
 * view only — summing both would double every number.
 *
 * Location view (Pro, `scope` = a warehouse / store Location.id, phase 3): the
 * table reads that location's VariantMetric scope and its StockNow only, and
 * lists the variants that have a metric there (the ones the location carries).
 * The variant detail page stays on the online stock pool.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import {
  CHART_DAYS,
  METRIC_SCOPE,
  pageInfo,
  toProductRow,
  type MetricRowIn,
  type OnOrderIn,
  type PageInfo,
  type ProductFilters,
  type ProductRow,
  type StockSumIn,
} from "../lib/products-shared";
import { addDays } from "../lib/engine/dates-shared";
import { todayIn } from "../lib/dashboard-shared";
import { POOL_LOCATION_SELECT, poolLocationIds } from "../lib/compute-shared";
import { ALL } from "../lib/sync/facts-shared";
import { kehaOnOrder } from "./reorder.server";

/** Keha orders that count as "on order" on Products: sent or confirmed (drafts aren't ordered yet). */
const ON_ORDER_STATUSES = ["sent", "confirmed"] as const;

/** The online stock pool's location ids (same rule as compute.server). */
async function poolIds(shop: string): Promise<string[]> {
  const locations = await prisma.location.findMany({ where: { shop }, select: POOL_LOCATION_SELECT });
  return poolLocationIds(locations);
}

/** Rows in one CSV export (a 5,000-variant store fits with room to spare). */
export const CSV_MAX_ROWS = 20_000;

/**
 * Variants the table lists: tracked, non-bundle (the engine's population —
 * bundles are never planned and untracked variants have no stock).
 */
async function variantWhere(shop: string, f: ProductFilters, scope: string): Promise<Prisma.VariantWhereInput> {
  const where: Prisma.VariantWhereInput = { shop, tracked: true, isBundle: false };
  if (f.vendor) where.vendor = f.vendor;
  if (f.collection) where.collections = { has: f.collection };
  if (f.q) {
    where.OR = [
      { productTitle: { contains: f.q, mode: "insensitive" } },
      { variantTitle: { contains: f.q, mode: "insensitive" } },
      { sku: { contains: f.q, mode: "insensitive" } },
    ];
  }
  if (f.status || scope !== METRIC_SCOPE) {
    // A status filter, or a location view (only the variants with a metric at that location).
    const ids = await prisma.variantMetric.findMany({
      where: { shop, scope, ...(f.status ? { status: f.status } : {}) },
      select: { variantId: true },
    });
    where.id = { in: ids.map((r) => r.variantId) };
  }
  return where;
}

const VARIANT_SELECT = {
  id: true,
  productTitle: true,
  variantTitle: true,
  sku: true,
  vendor: true,
  image: true,
} as const;

const ORDER: Prisma.VariantOrderByWithRelationInput[] = [{ productTitle: "asc" }, { variantTitle: "asc" }, { id: "asc" }];

/** Metrics and summed stock for a set of variants, by variant id. `scope`: "online" or a Location.id. */
async function joinFor(shop: string, ids: string[], scope: string) {
  if (ids.length === 0) {
    return { metrics: new Map<string, MetricRowIn>(), stock: new Map<string, StockSumIn>(), onOrder: new Map<string, OnOrderIn>() };
  }
  const pool = scope === METRIC_SCOPE ? await poolIds(shop) : [scope];
  const [metrics, stock, onOrder] = await Promise.all([
    prisma.variantMetric.findMany({
      where: { shop, scope, variantId: { in: ids } },
      select: { variantId: true, status: true, rate: true, daysLeft: true, neverRunsOut: true, orderQty: true, orderBy: true },
    }),
    pool.length
      ? prisma.stockNow.groupBy({
          by: ["variantId"],
          where: { shop, variantId: { in: ids }, locationId: { in: pool } },
          _sum: { onHand: true, incoming: true },
        })
      : Promise.resolve([]),
    kehaOnOrder(shop, ON_ORDER_STATUSES, ids),
  ]);
  return {
    onOrder: onOrder,
    metrics: new Map<string, MetricRowIn>(metrics.map((m) => [m.variantId, m])),
    stock: new Map<string, StockSumIn>(
      stock.map((s) => [s.variantId, { onHand: s._sum.onHand ?? null, incoming: s._sum.incoming ?? null }]),
    ),
  };
}

export type ProductPage = { rows: ProductRow[]; total: number; info: PageInfo };

export async function listProducts(
  shop: string,
  filters: ProductFilters,
  page: number,
  forecast: boolean,
  scope: string = METRIC_SCOPE,
): Promise<ProductPage> {
  const where = await variantWhere(shop, filters, scope);
  const total = await prisma.variant.count({ where });
  const info = pageInfo(total, page);
  const variants =
    total === 0
      ? []
      : await prisma.variant.findMany({ where, select: VARIANT_SELECT, orderBy: ORDER, skip: info.skip, take: info.take });
  const { metrics, stock, onOrder } = await joinFor(
    shop,
    variants.map((v) => v.id),
    scope,
  );
  return {
    rows: variants.map((v) => toProductRow(v, metrics.get(v.id), stock.get(v.id), forecast, onOrder.get(v.id))),
    total,
    info,
  };
}

/** Every filtered row (CSV export), capped at CSV_MAX_ROWS. */
export async function allProducts(
  shop: string,
  filters: ProductFilters,
  forecast: boolean,
  scope: string = METRIC_SCOPE,
): Promise<ProductRow[]> {
  const where = await variantWhere(shop, filters, scope);
  const variants = await prisma.variant.findMany({ where, select: VARIANT_SELECT, orderBy: ORDER, take: CSV_MAX_ROWS });
  const out: ProductRow[] = [];
  // Join in slices so each IN list stays small.
  for (let i = 0; i < variants.length; i += 1000) {
    const slice = variants.slice(i, i + 1000);
    const { metrics, stock, onOrder } = await joinFor(
      shop,
      slice.map((v) => v.id),
      scope,
    );
    for (const v of slice) out.push(toProductRow(v, metrics.get(v.id), stock.get(v.id), forecast, onOrder.get(v.id)));
  }
  return out;
}

/** Vendor and collection choices for the filters. */
export async function productFilterOptions(shop: string): Promise<{ vendors: string[]; collections: string[] }> {
  const [vendors, collections] = await Promise.all([
    prisma.variant.groupBy({
      by: ["vendor"],
      where: { shop, tracked: true, isBundle: false, vendor: { not: null } },
      orderBy: { vendor: "asc" },
      take: 500,
    }),
    prisma.$queryRaw<{ c: string }[]>`
      SELECT DISTINCT c FROM "Variant", unnest("collections") AS c
      WHERE "shop" = ${shop} AND "tracked" = true AND "isBundle" = false
      ORDER BY c LIMIT 500`,
  ]);
  return {
    vendors: vendors.map((v) => v.vendor).filter((v): v is string => !!v),
    collections: collections.map((r) => r.c).filter(Boolean),
  };
}

export type VariantDetail = {
  variant: {
    id: string;
    productTitle: string;
    variantTitle: string;
    sku: string | null;
    vendor: string | null;
    image: string | null;
  };
  row: ProductRow;
  /** Today in the store's time zone (the chart ends yesterday). */
  today: string;
  sigma: number | null;
  inputs: unknown;
  sales: { day: Date; sold: number }[];
  stock: { day: Date; outOfStock: boolean }[];
};

/** One variant with its metric, stock and 13 months of daily facts; null when not this shop's. */
export async function getVariantDetail(
  shop: string,
  variantId: string,
  forecast: boolean,
  now: Date = new Date(),
): Promise<VariantDetail | null> {
  const [variant, shopRow] = await Promise.all([
    prisma.variant.findFirst({ where: { id: variantId, shop }, select: VARIANT_SELECT }),
    prisma.shop.findUnique({ where: { domain: shop }, select: { timezone: true } }),
  ]);
  if (!variant) return null;
  const today = todayIn(shopRow?.timezone, now);
  const since = new Date(`${addDays(today, -CHART_DAYS)}T00:00:00Z`);
  const until = new Date(`${today}T00:00:00Z`);
  const pool = await poolIds(shop);
  const [metric, stockNow, sales, stock, onOrder] = await Promise.all([
    prisma.variantMetric.findUnique({ where: { shop_variantId_scope: { shop, variantId, scope: METRIC_SCOPE } } }),
    prisma.stockNow.aggregate({
      where: { shop, variantId, locationId: { in: pool } },
      _sum: { onHand: true, incoming: true },
    }),
    // Channel view only (locationKey "all"): one row per channel, never the location view too.
    prisma.salesDaily.groupBy({
      by: ["day"],
      where: { shop, variantId, locationKey: ALL, day: { gte: since, lt: until } },
      _sum: { sold: true },
      orderBy: { day: "asc" },
    }),
    prisma.stockDaily.findMany({
      where: { shop, variantId, locationId: { in: pool }, day: { gte: since, lt: until } },
      select: { day: true, outOfStock: true },
    }),
    kehaOnOrder(shop, ON_ORDER_STATUSES, [variantId]),
  ]);
  return {
    variant,
    row: toProductRow(
      variant,
      metric,
      { onHand: stockNow._sum.onHand ?? null, incoming: stockNow._sum.incoming ?? null },
      forecast,
      onOrder.get(variantId),
    ),
    today,
    sigma: metric?.sigma ?? null,
    inputs: metric?.inputs ?? null,
    sales: sales.map((s) => ({ day: s.day, sold: s._sum.sold ?? 0 })),
    stock,
  };
}
