/**
 * Order plan (Kanwar 2026-10-17; ordering audit 2026-10-17): the forward order plan for a stock
 * pool (the online pool, or one warehouse / store), from the latest VariantMetric run
 * (engine/forward-plan-shared planStore). Database only, no Shopify calls.
 *
 * ONE function behind the Dashboard ("Order this week"), Order now, Next 90 days, Products
 * ("To order", order-by date), Sidekick and the Monday email: every order is placed on its
 * order-by date, with the supplier's minimums (per line, per style, per order in units and in
 * money) applied per batch — so the Dashboard's cash is Order now's cash.
 *
 * Read per variant: the stored metric (rate, σ, status, orderQty and its inputs: seasonal and
 * trend, the seasonal shape, safety, lead time, cycle, on hand, incoming with dates, orderNeed),
 * the supplier (Settings → Suppliers, else matched by vendor) for the case pack and minimums,
 * and the open Keha units compute did not count yet (fresh drafts, orders sent since the run).
 * Drafts older than DRAFT_EXPIRY_DAYS don't count (they are reported, not netted). Variants the
 * merchant marked "Don't reorder" are left out (and counted).
 *
 * Only metrics that can produce an order inside the 13 weeks are read: an order today
 * (orderQty > 0), an order-by date up to the end of the calendar, or a variant with open Keha
 * units (expired drafts move its date earlier). For suppliers with a minimum per style, the
 * other variants of each style are read too (they share the minimum).
 *
 * Valuation: always in the store's currency, from Shopify's cost per item (Variant.cost). A cost
 * stored in another currency is converted only with the supplier's exchange rate; otherwise that
 * line is unknown ("—", counted) — never the whole order.
 */
import prisma from "../db.server";
import { addDays, type DayKey } from "../lib/engine/dates-shared";
import {
  forwardInputFromMetric,
  planDays,
  planEnd,
  planStore,
  type PlanEvent,
  type PlanSkip,
  type PlanSupplierRules,
  type PlanVariantSpec,
} from "../lib/engine/forward-plan-shared";
import { METRIC_SCOPE } from "../lib/products-shared";
import { REORDER_HOLD_STATUSES } from "../lib/purchase-order-shared";
import { supplierGroupKey, vendorGroupKey } from "../lib/reorder-shared";
import { casePackFor, readMinOrderScope, supplierFor, toStoreCurrency, type SupplierLite } from "../lib/supplier-shared";
import { todayIn } from "../lib/dashboard-shared";
import { ALL, dayDate } from "../lib/sync/facts-shared";
import { lineCosts, LAST_YEAR_OFFSET_DAYS, type OrderPlanData, type PlanSupplierInfo, type PlanVariantInfo } from "../lib/order-plan-shared";
import { kehaOnOrder, shopBasics, staleDraftCount } from "./reorder.server";

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};

/** VariantMetric.inputs.kehaOnOrder: Keha units compute already counted as incoming. */
function kehaCounted(inputs: unknown): number {
  const v = inputs && typeof inputs === "object" ? (inputs as Record<string, unknown>).kehaOnOrder : undefined;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function inputNum(inputs: unknown, key: string): number | null {
  const v = inputs && typeof inputs === "object" ? (inputs as Record<string, unknown>)[key] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Distinct products of these variants (variants marked "Don't reorder" left out). */
async function productCount(shop: string, variantIds: string[]): Promise<number> {
  if (!variantIds.length) return 0;
  const rows = await prisma.variant.findMany({ where: { shop, id: { in: variantIds }, NOT: { noReorder: true } }, select: { productId: true } });
  return new Set(rows.map((r) => r.productId)).size;
}

const SUPPLIER_SELECT = {
  id: true,
  name: true,
  email: true,
  leadTimeDays: true,
  minOrder: true,
  minOrderTotal: true,
  casePack: true,
  vendorMatch: true,
  currency: true,
  transitDays: true,
  minOrderValue: true,
  minOrderScope: true,
  exchangeRate: true,
} as const;

const VARIANT_SELECT = {
  id: true,
  productId: true,
  productTitle: true,
  variantTitle: true,
  sku: true,
  vendor: true,
  image: true,
  supplierId: true,
  caseQty: true,
  cost: true,
  costCurrency: true,
  price: true,
  noReorder: true,
  productCreatedAt: true,
} as const;

const METRIC_SELECT = { variantId: true, status: true, rate: true, sigma: true, orderQty: true, orderBy: true, daysLeft: true, neverRunsOut: true, inputs: true } as const;

export type PlanSupplierRow = SupplierLite & { email: string | null; currency: string | null };

/** Supplier rows of a shop with the ordering fields read defensively (Decimal → number). */
export async function planSuppliers(shop: string): Promise<PlanSupplierRow[]> {
  const rows = await prisma.supplier.findMany({ where: { shop }, select: SUPPLIER_SELECT });
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    email: s.email ?? null,
    leadTimeDays: s.leadTimeDays,
    minOrder: s.minOrder ?? null,
    minOrderTotal: s.minOrderTotal ?? null,
    casePack: s.casePack ?? null,
    vendorMatch: s.vendorMatch ?? [],
    currency: s.currency ?? null,
    transitDays: s.transitDays ?? null,
    minOrderValue: num(s.minOrderValue),
    minOrderScope: readMinOrderScope(s.minOrderScope),
    exchangeRate: num(s.exchangeRate),
  }));
}

/** Per variant, for Products and Order now: the plan's order-by date and why it can't be planned. */
export type PlanVariantState = { deadline: DayKey | null; skip: PlanSkip | null; supplierKey: string; noReorder: boolean };

export type OrderPlanOptions = {
  /** "online" (default) or a Location.id (Pro location views). */
  scope?: string;
  /** Also read last year's sales in each order's weeks (Order now, Next 90 days). */
  lastYear?: boolean;
};

export type OrderPlanDetail = {
  data: OrderPlanData;
  /** Every variant the plan read (with or without orders). */
  state: Map<string, PlanVariantState>;
  suppliers: PlanSupplierRow[];
};

/** The forward plan with the per-variant state Products and Order now need (server only). */
export async function computeOrderPlan(shop: string, now: Date = new Date(), opts: OrderPlanOptions = {}): Promise<OrderPlanDetail> {
  const scope = opts.scope ?? METRIC_SCOPE;
  const basics = await shopBasics(shop);
  const today: DayKey = todayIn(basics.timezone, now);
  const days = planDays(today);
  const [onOrderAll, supplierRows, staleDrafts] = await Promise.all([
    // Open Keha units that still count (sent, confirmed, drafts up to 14 days old).
    kehaOnOrder(shop, REORDER_HOLD_STATUSES, undefined, { now }),
    planSuppliers(shop),
    staleDraftCount(shop, now),
  ]);
  const withKeha = [...onOrderAll.keys()];
  const [metricRows, unplannable] = await Promise.all([
    prisma.variantMetric.findMany({
      where: {
        shop,
        scope,
        status: { notIn: ["dead", "not_enough_data"] },
        OR: [
          { orderQty: { gt: 0 } },
          { orderBy: { lte: dayDate(addDays(planEnd(today), 1)) } },
          ...(withKeha.length ? [{ variantId: { in: withKeha } }] : []),
        ],
      },
      select: METRIC_SELECT,
    }),
    prisma.variantMetric.findMany({
      where: { shop, scope, status: { in: ["dead", "not_enough_data"] } },
      select: { variantId: true, status: true },
    }),
  ]);
  const metrics = new Map(metricRows.map((m) => [m.variantId, m]));
  const ids = [...metrics.keys()];
  const [variantRows, noData, dead] = await Promise.all([
    ids.length ? prisma.variant.findMany({ where: { shop, id: { in: ids }, tracked: true, isBundle: false }, select: VARIANT_SELECT }) : Promise.resolve([]),
    productCount(shop, unplannable.filter((m) => m.status === "not_enough_data").map((m) => m.variantId)),
    productCount(shop, unplannable.filter((m) => m.status === "dead").map((m) => m.variantId)),
  ]);
  const variants = [...variantRows];

  // Minimum per style: the other variants of each style share it, so read them too.
  const styleProducts = new Set<string>();
  for (const v of variants) {
    const s = supplierFor(v, supplierRows);
    if (s?.minOrderScope === "product" && s.minOrder) styleProducts.add(v.productId);
  }
  if (styleProducts.size) {
    const known = new Set(variants.map((v) => v.id));
    const siblings = (
      await prisma.variant.findMany({ where: { shop, productId: { in: [...styleProducts] }, tracked: true, isBundle: false, NOT: { noReorder: true } }, select: VARIANT_SELECT })
    ).filter((v) => !known.has(v.id));
    if (siblings.length) {
      const sibMetrics = await prisma.variantMetric.findMany({
        where: { shop, scope, variantId: { in: siblings.map((v) => v.id) }, status: { notIn: ["dead", "not_enough_data"] } },
        select: METRIC_SELECT,
      });
      for (const m of sibMetrics) metrics.set(m.variantId, m);
      const withMetric = new Set(sibMetrics.map((m) => m.variantId));
      variants.push(...siblings.filter((v) => withMetric.has(v.id)));
    }
  }

  const state = new Map<string, PlanVariantState>();
  const suppliers: Record<string, PlanSupplierInfo> = {};
  const rules: Record<string, PlanSupplierRules> = {};
  const specs: PlanVariantSpec[] = [];
  const byId = new Map(variants.map((v) => [v.id, v]));
  const notReordered = new Set<string>();
  const storeCur = basics.currency.toUpperCase();
  for (const v of variants) {
    const m = metrics.get(v.id);
    if (!m) continue;
    const supplier = supplierFor(v, supplierRows);
    const key = supplier ? supplierGroupKey(supplier.id) : vendorGroupKey(v.vendor);
    if (v.noReorder) {
      notReordered.add(v.productId);
      state.set(v.id, { deadline: null, skip: null, supplierKey: key, noReorder: true });
      continue;
    }
    const style = supplier?.minOrderScope === "product";
    const pack = casePackFor(v.caseQty, supplier);
    const counted = onOrderAll.get(v.id)?.qty ?? 0;
    const notCounted = Math.max(0, counted - kehaCounted(m.inputs));
    const fRate = m.rate !== null ? m.rate * (inputNum(m.inputs, "seasonal") ?? 1) * (inputNum(m.inputs, "trend") ?? 1) : null;
    const costs = lineCosts(num(v.cost), v.costCurrency, storeCur, supplier?.currency ?? null, supplier?.exchangeRate ?? null);
    specs.push({
      variantId: v.id,
      productId: v.productId,
      supplierKey: key,
      unitCost: costs.store,
      weight: fRate ?? 0,
      input: forwardInputFromMetric(m, { today, pack, moq: style ? null : (supplier?.minOrder ?? null), notCounted, days }),
    });
    if (!suppliers[key]) {
      const supCur = (supplier?.currency || basics.currency).toUpperCase();
      const minValue = supplier?.minOrderValue ?? null;
      const minValueStore = minValue === null ? null : supCur === storeCur ? minValue : toStoreCurrency(minValue, supplier?.exchangeRate);
      suppliers[key] = supplier
        ? {
            key,
            kind: "supplier",
            supplierId: supplier.id,
            name: supplier.name,
            currency: supCur,
            exchangeRate: supplier.exchangeRate ?? null,
            minOrderTotal: supplier.minOrderTotal ?? null,
            minOrderValue: minValue,
            minOrderValueStore: minValueStore,
            minOrder: supplier.minOrder ?? null,
            minOrderScope: supplier.minOrderScope ?? "variant",
            leadTimeDays: supplier.leadTimeDays,
            leadTimeSource: "supplier",
            hasEmail: !!supplier.email,
            cycleDays: null,
          }
        : {
            key,
            kind: "vendor",
            supplierId: null,
            name: (v.vendor ?? "").trim(),
            currency: storeCur,
            exchangeRate: null,
            minOrderTotal: null,
            minOrderValue: null,
            minOrderValueStore: null,
            minOrder: null,
            minOrderScope: "variant",
            leadTimeDays: basics.leadTimeDays,
            leadTimeSource: "default",
            hasEmail: false,
            cycleDays: null,
          };
      rules[key] = {
        styleMin: style ? (supplier?.minOrder ?? null) : null,
        minTotal: supplier?.minOrderTotal ?? null,
        minValue: minValueStore,
      };
    }
    const cyc = inputNum(m.inputs, "cycleDays");
    const info = suppliers[key]!;
    if (cyc !== null && (info.cycleDays === null || info.cycleDays === undefined || cyc > info.cycleDays)) info.cycleDays = cyc;
  }

  const plan = planStore(specs, rules, today);
  // Rows written before the plan's inputs existed can't be projected: they keep compute's date.
  const storedBy = (id: string) => {
    const d = metrics.get(id)?.orderBy;
    return d instanceof Date ? d.toISOString().slice(0, 10) : null;
  };
  for (const s of specs) {
    const p = plan.variants.get(s.variantId);
    state.set(s.variantId, { deadline: p?.deadline ?? (p?.skip ? null : storedBy(s.variantId)), skip: p?.skip ?? null, supplierKey: s.supplierKey, noReorder: false });
  }
  const events = plan.events;
  for (const e of events) {
    if (e.deadline !== null) continue;
    e.deadline = storedBy(e.variantId);
    e.overdue = e.deadline !== null && e.deadline < today && e.orderBy === today;
  }
  if (opts.lastYear && events.length) await addLastYear(shop, today, events, byId);

  const variantInfo: Record<string, PlanVariantInfo> = {};
  const withOrders = new Set(events.map((e) => e.variantId));
  for (const id of withOrders) {
    const v = byId.get(id)!;
    const m = metrics.get(id)!;
    const supplier = supplierFor(v, supplierRows);
    const price = num(v.price);
    const fRate = m.rate !== null ? m.rate * (inputNum(m.inputs, "seasonal") ?? 1) * (inputNum(m.inputs, "trend") ?? 1) : null;
    const costs = lineCosts(num(v.cost), v.costCurrency, storeCur, supplier?.currency ?? null, supplier?.exchangeRate ?? null);
    variantInfo[id] = {
      variantId: id,
      productId: v.productId,
      productTitle: v.productTitle,
      variantTitle: v.variantTitle,
      sku: v.sku,
      image: v.image,
      daysLeft: m.daysLeft,
      neverRunsOut: m.neverRunsOut,
      deadline: state.get(id)?.deadline ?? null,
      valuePerDay: fRate !== null && price !== null ? fRate * price : null,
      rate: m.rate,
      unitCostSupplier: costs.supplier,
      pack: casePackFor(v.caseQty, supplier),
      moq: supplier?.minOrderScope === "product" ? null : (supplier?.minOrder ?? null),
    };
  }
  return {
    data: {
      today,
      currency: basics.currency,
      timezone: basics.timezone,
      events,
      variants: variantInfo,
      suppliers,
      suppliersSetUp: supplierRows.length > 0,
      cantPlan: { noData, dead },
      batches: plan.batches,
      staleDrafts,
      notReordered: notReordered.size,
    },
    state,
    suppliers: supplierRows,
  };
}

/**
 * Last year's sales in each order's weeks: the `why.days` window starting on the order day,
 * 364 days earlier (same weekdays), from SalesDaily's channel view (locationKey "all": every
 * channel once, as compute and the product page read it). Unknown (null) when the store's
 * history or the product doesn't reach back to the window's start.
 */
async function addLastYear(
  shop: string,
  today: DayKey,
  events: PlanEvent[],
  variants: ReadonlyMap<string, { productCreatedAt: Date | null }>,
): Promise<void> {
  const ids = [...new Set(events.map((e) => e.variantId))];
  const span = (e: PlanEvent) => {
    const from = addDays(e.orderBy, -LAST_YEAR_OFFSET_DAYS);
    return { from, to: addDays(from, Math.max(1, e.why?.days ?? 1)) };
  };
  let lo = today;
  let hi = today;
  for (const e of events) {
    const s = span(e);
    if (s.from < lo) lo = s.from;
    if (s.to > hi) hi = s.to;
  }
  const [rows, first, storeFirst] = await Promise.all([
    prisma.salesDaily.groupBy({
      by: ["variantId", "day"],
      where: { shop, variantId: { in: ids }, locationKey: ALL, day: { gte: dayDate(lo), lt: dayDate(hi) } },
      _sum: { sold: true },
    }),
    prisma.salesDaily.groupBy({ by: ["variantId"], where: { shop, variantId: { in: ids }, locationKey: ALL }, _min: { day: true } }),
    prisma.salesDaily.aggregate({ where: { shop, locationKey: ALL }, _min: { day: true } }),
  ]);
  const dayKey = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : typeof d === "string" ? d.slice(0, 10) : null);
  const sold = new Map<string, { day: DayKey; sold: number }[]>();
  for (const r of rows) {
    const d = dayKey(r.day);
    if (!d) continue;
    (sold.get(r.variantId) ?? sold.set(r.variantId, []).get(r.variantId)!).push({ day: d, sold: Number(r._sum.sold ?? 0) });
  }
  const firstSale = new Map(first.map((r) => [r.variantId, dayKey(r._min.day)]));
  const since = dayKey(storeFirst._min.day);
  for (const e of events) {
    const s = span(e);
    const v = variants.get(e.variantId);
    const created = v?.productCreatedAt ? v.productCreatedAt.toISOString().slice(0, 10) : null;
    const productSince = [created, firstSale.get(e.variantId) ?? null].filter((x): x is string => !!x).sort()[0] ?? null;
    if (!since || since > s.from || !productSince || productSince > s.from) {
      e.lastYear = null;
      continue;
    }
    let total = 0;
    for (const r of sold.get(e.variantId) ?? []) if (r.day >= s.from && r.day < s.to) total += r.sold;
    e.lastYear = total;
  }
}

/** The forward plan (Dashboard, Order plan tabs, Products, Sidekick, the Monday email). */
export async function loadOrderPlan(shop: string, now: Date = new Date(), opts: OrderPlanOptions = {}): Promise<OrderPlanData> {
  return (await computeOrderPlan(shop, now, opts)).data;
}
