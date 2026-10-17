/**
 * Products table and variant detail (spec §5.2). Database reads only; the
 * mapping lives in app/lib/products-shared.ts. Everything here uses the same
 * supplier-order pool as compute (VariantMetric scope "online"; every active
 * location unless left out, countsForOnline): stock now, incoming and sold-out
 * days come from the same locations, so a row can't read "Stock now 40 · Out".
 *
 * SalesDaily holds two views of the same sales (facts-shared): by location
 * (channel "all") and by channel (locationKey "all"). Totals read the channel
 * view only — summing both would double every number.
 *
 * Location view (Pro, `scope` = a warehouse / store Location.id, phase 3): the
 * table reads that location's VariantMetric scope and its StockNow only, and
 * lists the variants that have a metric there (the ones the location carries).
 * The variant detail page stays on the online stock pool.
 *
 * "To order" and the order-by date come from the forward plan (models/order-plan.server, the
 * same function as Order now and the Dashboard; ordering audit 2026-10-17): the variant's next
 * planned order — after open Keha orders and the supplier's minimums — and its real order-by
 * date. Sorted by that date by default (forecast on), with a supplier filter. A variant marked
 * "Don't reorder" shows "Not reordered" and is sorted last.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { facts } from "../services/facts-store.server";
import { variantLine, type PlanEvent } from "../lib/engine/forward-plan-shared";
import { supplierFor } from "../lib/supplier-shared";
import { readSettings, type TrendMode } from "../lib/settings-shared";
import { cachedOrderPlan, planSuppliers, type PlanVariantState } from "./order-plan.server";
import {
  CHART_DAYS,
  METRIC_SCOPE,
  pageInfo,
  readSeasonSource,
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
import { forgetOrderPlan } from "./plan-cache.server";

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
 * Most ids one Prisma `in` list may carry (DB scale #5). Postgres takes at most 32,767 bind
 * parameters per statement; a status filter or a location view on a large store can match more
 * variants than that. Above this the restriction is applied in memory instead (VariantQuery).
 */
export const MAX_IN_IDS = 10_000;

/**
 * The filtered variants: a Prisma where, plus `only` — the ids a status filter / location view
 * allows when there are too many for an `in` list (null = `where` says it all).
 */
type VariantQuery = { where: Prisma.VariantWhereInput; only: Set<string> | null };

/**
 * Variants the table lists: tracked, non-bundle (the engine's population —
 * bundles are never planned and untracked variants have no stock).
 */
async function variantWhere(shop: string, f: ProductFilters, scope: string): Promise<VariantQuery> {
  const where: Prisma.VariantWhereInput = { shop, tracked: true, isBundle: false };
  if (f.vendor) where.vendor = f.vendor;
  if (f.productType) where.productType = f.productType;
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
    if (ids.length > MAX_IN_IDS) return { where, only: new Set(ids.map((r) => r.variantId)) };
    where.id = { in: ids.map((r) => r.variantId) };
  }
  return { where, only: null };
}

/**
 * The query's variant ids in table order (ORDER), `take` at most. With `only` the ids are read
 * without the id list (one narrow query, ids only) and filtered here, so no statement ever
 * carries more than MAX_IN_IDS ids.
 */
async function matchingIds(q: VariantQuery, take: number): Promise<string[]> {
  if (!q.only) {
    const rows = await prisma.variant.findMany({ where: q.where, select: { id: true }, orderBy: ORDER, take });
    return rows.map((r) => r.id);
  }
  const rows = await prisma.variant.findMany({ where: q.where, select: { id: true }, orderBy: ORDER });
  const out: string[] = [];
  for (const r of rows) {
    if (!q.only.has(r.id)) continue;
    out.push(r.id);
    if (out.length >= take) break;
  }
  return out;
}

/** Rows for ids, `in` lists of at most MAX_IN_IDS (results in no particular order). */
async function variantsByIds<S extends Prisma.VariantSelect>(shop: string, ids: string[], select: S) {
  const out: Prisma.VariantGetPayload<{ select: S }>[] = [];
  for (let i = 0; i < ids.length; i += MAX_IN_IDS) {
    out.push(...((await prisma.variant.findMany({ where: { shop, id: { in: ids.slice(i, i + MAX_IN_IDS) } }, select })) as Prisma.VariantGetPayload<{ select: S }>[]));
  }
  return out;
}

const VARIANT_SELECT = {
  id: true,
  productId: true,
  productTitle: true,
  variantTitle: true,
  sku: true,
  vendor: true,
  image: true,
  noReorder: true,
} as const;

type PlanLine = NonNullable<ReturnType<typeof variantLine>>;

/** The forward plan, per variant: its order line (Order now's, M4) and its plan state. */
export type PlanView = { line: Map<string, PlanLine>; state: Map<string, PlanVariantState> };

export async function planView(shop: string, scope: string = METRIC_SCOPE, now: Date = new Date()): Promise<PlanView> {
  // The whole plan sorts the table; reused while nothing it reads changed (order-plan.server).
  const { data, state } = await cachedOrderPlan(shop, now, { scope });
  const byVariant = new Map<string, PlanEvent[]>();
  for (const e of data.events) (byVariant.get(e.variantId) ?? byVariant.set(e.variantId, []).get(e.variantId)!).push(e);
  const line = new Map<string, PlanLine>();
  for (const [id, events] of byVariant) {
    const l = variantLine(events, data.today);
    if (l) line.set(id, l);
  }
  return { line, state };
}

/**
 * "To order" and "Order by" from the forward plan, one rule with Order now (M4, variantLine):
 * the variant's orders due in the next 7 days added together at the earliest date (overdue: the
 * date that passed; null when already out with no known run-out day, M3), else its next planned
 * order. Without a planned order in the 13 weeks: nothing to order ("—") and the plan's date.
 */
export function withPlan(row: ProductRow, view: PlanView | null, noReorder: boolean): ProductRow {
  if (noReorder) return { ...row, noReorder: true, orderQty: null, orderBy: null, overdue: false };
  if (!view) return { ...row, noReorder: false };
  const l = view.line.get(row.id);
  if (l) return { ...row, noReorder: false, orderQty: l.qty, orderBy: l.orderBy, overdue: l.overdue };
  const st = view.state.get(row.id);
  return { ...row, noReorder: false, orderQty: null, orderBy: st ? st.deadline : row.orderBy, overdue: false };
}

const ORDER: Prisma.VariantOrderByWithRelationInput[] = [{ productTitle: "asc" }, { variantTitle: "asc" }, { id: "asc" }];

/** Supplier filter value of a variant: its Settings → Suppliers id, or "none". */
function supplierValue(v: { supplierId: string | null; vendor: string | null }, suppliers: Awaited<ReturnType<typeof planSuppliers>>): string {
  return supplierFor(v, suppliers)?.id ?? "none";
}

/**
 * The filtered variant ids in table order: by order-by date (the plan's, else the stored one;
 * nothing last, "Don't reorder" after that), or by product name; with the supplier filter.
 */
async function orderedIds(
  shop: string,
  q: VariantQuery,
  f: ProductFilters,
  scope: string,
  view: PlanView | null,
): Promise<string[]> {
  const select = { id: true, supplierId: true, vendor: true, noReorder: true } as const;
  const [rows, suppliers] = await Promise.all([
    q.only
      ? matchingIds(q, CSV_MAX_ROWS).then(async (ids) => {
          const pos = new Map(ids.map((id, i) => [id, i]));
          return (await variantsByIds(shop, ids, select)).sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
        })
      : prisma.variant.findMany({ where: q.where, select, orderBy: ORDER, take: CSV_MAX_ROWS }),
    f.supplier ? planSuppliers(shop) : Promise.resolve([]),
  ]);
  const list = f.supplier ? rows.filter((r) => supplierValue(r, suppliers) === f.supplier) : rows;
  if (!view || f.sort === "title") return list.map((r) => r.id);
  const stored = new Map(
    (await prisma.variantMetric.findMany({ where: { shop, scope }, select: { variantId: true, orderBy: true } })).map((m) => [m.variantId, m.orderBy ? m.orderBy.toISOString().slice(0, 10) : null]),
  );
  const key = (r: { id: string; noReorder: boolean }): [number, string] => {
    if (r.noReorder) return [2, ""];
    const l = view.line.get(r.id);
    // Overdue with no date (already out, run-out day unknown): first.
    if (l?.overdue && !l.orderBy) return [0, ""];
    const st = view.state.get(r.id);
    const d = l ? l.orderBy : st ? st.deadline : (stored.get(r.id) ?? null);
    return d ? [0, d] : [1, ""];
  };
  const keyed = list.map((r, i) => ({ id: r.id, i, k: key(r) }));
  keyed.sort((a, b) => a.k[0] - b.k[0] || a.k[1].localeCompare(b.k[1]) || a.i - b.i);
  return keyed.map((x) => x.id);
}

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
  now: Date = new Date(),
): Promise<ProductPage> {
  const q = await variantWhere(shop, filters, scope);
  const view = forecast ? await planView(shop, scope, now) : null;
  // By order-by date (the default with the forecast) or a supplier filter: ordered in memory.
  const inMemory = (!!view && filters.sort !== "title") || !!filters.supplier;
  let total: number;
  let info: PageInfo;
  let variants: { id: string; productId: string; productTitle: string; variantTitle: string; sku: string | null; vendor: string | null; image: string | null; noReorder: boolean }[];
  if (inMemory) {
    const ids = await orderedIds(shop, q, filters, scope, view);
    total = ids.length;
    info = pageInfo(total, page);
    const pageIds = ids.slice(info.skip, info.skip + info.take);
    const rows = pageIds.length ? await prisma.variant.findMany({ where: { shop, id: { in: pageIds } }, select: VARIANT_SELECT }) : [];
    const pos = new Map(pageIds.map((id, i) => [id, i]));
    variants = rows.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
  } else if (q.only) {
    // Too many allowed ids for an `in` list: page over the ordered ids in memory.
    const ids = await matchingIds(q, Number.MAX_SAFE_INTEGER);
    total = ids.length;
    info = pageInfo(total, page);
    const pageIds = ids.slice(info.skip, info.skip + info.take);
    const pos = new Map(pageIds.map((id, i) => [id, i]));
    variants = (await variantsByIds(shop, pageIds, VARIANT_SELECT)).sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
  } else {
    total = await prisma.variant.count({ where: q.where });
    info = pageInfo(total, page);
    variants = total === 0 ? [] : await prisma.variant.findMany({ where: q.where, select: VARIANT_SELECT, orderBy: ORDER, skip: info.skip, take: info.take });
  }
  const { metrics, stock, onOrder } = await joinFor(
    shop,
    variants.map((v) => v.id),
    scope,
  );
  return {
    rows: variants.map((v) => withPlan({ ...toProductRow(v, metrics.get(v.id), stock.get(v.id), forecast, onOrder.get(v.id)), productId: v.productId }, view, !!v.noReorder)),
    total,
    info,
  };
}

/** Every filtered row (CSV export), capped at CSV_MAX_ROWS, in the table's order. */
export async function allProducts(
  shop: string,
  filters: ProductFilters,
  forecast: boolean,
  scope: string = METRIC_SCOPE,
  now: Date = new Date(),
): Promise<ProductRow[]> {
  const q = await variantWhere(shop, filters, scope);
  const view = forecast ? await planView(shop, scope, now) : null;
  const ids = await orderedIds(shop, q, filters, scope, view);
  const out: ProductRow[] = [];
  // Join in slices so each IN list stays small.
  for (let i = 0; i < ids.length; i += 1000) {
    const sliceIds = ids.slice(i, i + 1000);
    const rows = await prisma.variant.findMany({ where: { shop, id: { in: sliceIds } }, select: VARIANT_SELECT });
    const pos = new Map(sliceIds.map((id, k) => [id, k]));
    const slice = rows.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    const { metrics, stock, onOrder } = await joinFor(
      shop,
      slice.map((v) => v.id),
      scope,
    );
    for (const v of slice) out.push(withPlan({ ...toProductRow(v, metrics.get(v.id), stock.get(v.id), forecast, onOrder.get(v.id)), productId: v.productId }, view, !!v.noReorder));
  }
  return out;
}

/** Supplier choices for the filter (Settings → Suppliers, then "No supplier"). */
export async function supplierFilterOptions(shop: string): Promise<{ id: string; name: string }[]> {
  const rows = await prisma.supplier.findMany({ where: { shop }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/**
 * The product's own case size (written to every variant of the product: Variant.caseQty wins
 * over the supplier's case pack). null clears it. Our database only — the store isn't changed.
 */
export async function setProductCaseSize(shop: string, productId: string, caseQty: number | null): Promise<{ ok: true; count: number } | { ok: false }> {
  const r = await prisma.variant.updateMany({ where: { shop, productId }, data: { caseQty } });
  if (r.count > 0) forgetOrderPlan(shop);
  return r.count > 0 ? { ok: true, count: r.count } : { ok: false };
}

/**
 * The supplier's article / style code for the product (written to every variant of the product),
 * shown on the purchase order PDF / size-grid CSV. null clears it. Our database only.
 */
export async function setProductSupplierCode(shop: string, productId: string, supplierCode: string | null): Promise<{ ok: true; count: number } | { ok: false }> {
  const r = await prisma.variant.updateMany({ where: { shop, productId }, data: { supplierCode } });
  return r.count > 0 ? { ok: true, count: r.count } : { ok: false };
}

/** Vendor, product type and collection choices for the filters. */
export async function productFilterOptions(shop: string): Promise<{ vendors: string[]; collections: string[]; productTypes: string[] }> {
  const [vendors, types, collections] = await Promise.all([
    prisma.variant.groupBy({
      by: ["vendor"],
      where: { shop, tracked: true, isBundle: false, vendor: { not: null } },
      orderBy: { vendor: "asc" },
      take: 500,
    }),
    prisma.variant.groupBy({
      by: ["productType"],
      where: { shop, tracked: true, isBundle: false, productType: { not: null } },
      orderBy: { productType: "asc" },
      take: 500,
    }),
    prisma.$queryRaw<{ c: string }[]>`
      SELECT DISTINCT c FROM "Variant", unnest("collections") AS c
      WHERE "shop" = ${shop} AND "tracked" = true AND "isBundle" = false
      ORDER BY c LIMIT 500`,
  ]);
  return {
    vendors: vendors.map((v) => v.vendor).filter((v): v is string => !!v),
    productTypes: types.map((v) => v.productType).filter((v): v is string => !!v && v.trim() !== ""),
    collections: collections.map((r) => r.c).filter(Boolean),
  };
}

export type VariantDetail = {
  variant: {
    id: string;
    productId: string;
    productTitle: string;
    /** R4: the product type ("Plan like…" suggests its median pace). */
    productType?: string | null;
    variantTitle: string;
    sku: string | null;
    vendor: string | null;
    image: string | null;
    noReorder: boolean;
  };
  /** The product's own case size (null: the supplier's case pack applies). */
  caseQty: number | null;
  /** The supplier's article / style code for the product (purchase order documents); null = none. */
  supplierCode?: string | null;
  /** Variants of the same product (the "Don't reorder" choice for the whole product). */
  siblings: { id: string; variantTitle: string; noReorder: boolean }[];
  /** Settings → growth assumption (the Trend row). */
  trendMode: TrendMode;
  row: ProductRow;
  /** Today in the store's time zone (the chart ends yesterday). */
  today: string;
  sigma: number | null;
  inputs: unknown;
  /** Title of the collection the seasonal pattern came from (inputs.season); null otherwise or when it is gone. */
  seasonCollection: string | null;
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
    prisma.variant.findFirst({ where: { id: variantId, shop }, select: { ...VARIANT_SELECT, caseQty: true, productType: true } }),
    prisma.shop.findUnique({ where: { domain: shop }, select: { timezone: true, settings: true } }),
  ]);
  if (!variant) return null;
  const [siblings, view] = await Promise.all([
    prisma.variant.findMany({ where: { shop, productId: variant.productId }, select: { id: true, variantTitle: true, noReorder: true, caseQty: true, supplierCode: true }, orderBy: [{ variantTitle: "asc" }, { id: "asc" }] }),
    forecast ? planView(shop, METRIC_SCOPE, now) : Promise.resolve(null),
  ]);
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
    facts.salesDaily.groupBy({
      by: ["day"],
      where: { shop, variantId, locationKey: ALL, day: { gte: since, lt: until } },
      _sum: { sold: true },
      orderBy: { day: "asc" },
    }),
    facts.stockDaily.findMany({
      where: { shop, variantId, locationId: { in: pool }, day: { gte: since, lt: until } },
      select: { day: true, outOfStock: true },
    }),
    kehaOnOrder(shop, ON_ORDER_STATUSES, [variantId]),
  ]);
  const caseQtys = [...new Set(siblings.map((v) => v.caseQty ?? null))];
  const source = readSeasonSource((metric?.inputs as Record<string, unknown> | null | undefined)?.season);
  const seasonCollection =
    source?.level === "collection"
      ? ((await prisma.collection.findFirst({ where: { shop, id: source.collectionId }, select: { title: true } }))?.title ?? null)
      : null;
  return {
    variant: { id: variant.id, productId: variant.productId, productTitle: variant.productTitle, productType: variant.productType ?? null, variantTitle: variant.variantTitle, sku: variant.sku, vendor: variant.vendor, image: variant.image, noReorder: !!variant.noReorder },
    caseQty: caseQtys.length === 1 ? caseQtys[0]! : (variant.caseQty ?? null),
    supplierCode: siblings.find((v) => v.id === variant.id)?.supplierCode ?? siblings.find((v) => v.supplierCode)?.supplierCode ?? null,
    siblings: siblings.map((v) => ({ id: v.id, variantTitle: v.variantTitle, noReorder: !!v.noReorder })),
    trendMode: readSettings(shopRow?.settings).trendMode,
    row: withPlan(
      {
        ...toProductRow(variant, metric, { onHand: stockNow._sum.onHand ?? null, incoming: stockNow._sum.incoming ?? null }, forecast, onOrder.get(variantId)),
        productId: variant.productId,
      },
      view,
      !!variant.noReorder,
    ),
    today,
    sigma: metric?.sigma ?? null,
    inputs: metric?.inputs ?? null,
    seasonCollection,
    sales: sales.map((s) => ({ day: s.day, sold: s._sum.sold ?? 0 })),
    stock,
  };
}
