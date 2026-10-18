/**
 * Order plan (Kanwar 2026-10-17; ordering audit 2026-10-17): the forward order plan for a stock
 * pool (the online pool, or one warehouse / store), from the latest VariantMetric run
 * (engine/forward-plan-shared planStore). Database only, no Shopify calls.
 *
 * ONE function behind the Dashboard ("Order this week"), Order now, Next 13 weeks, Products
 * ("To order", order-by date), Sidekick and the Monday email: every order is placed on its
 * order-by date, with the supplier's minimums (per line, per style, per order in units and in
 * money) applied per batch — so the Dashboard's cash is Order now's cash.
 *
 * Read per variant: the stored metric (rate, σ, status, orderQty and its inputs: seasonal and
 * trend, the seasonal shape, safety, lead time, cycle, on hand, incoming with dates, orderNeed),
 * the supplier (Settings → Suppliers, else matched by vendor) for the case pack and minimums,
 * and what changed on Keha orders since the run (lib/keha-since-run-shared, H2): units compute
 * did not count yet (fresh drafts, orders sent since) arrive after one lead time; units of an
 * order closed short, cancelled or deleted since come out of the incoming at once.
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
import { facts } from "../services/facts-store.server";
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
import { kehaSinceRun, readKehaShares, type KehaOrderNow } from "../lib/keha-since-run-shared";
import { supplierGroupKey, vendorGroupKey } from "../lib/reorder-shared";
import {
  casePackFor,
  lineRemaining,
  onOrderByVariant,
  poArrival,
  poCountsAsOrdered,
  readMinOrderScope,
  supplierFor,
  toStoreCurrency,
  type SupplierLite,
} from "../lib/supplier-shared";
import { todayIn } from "../lib/dashboard-shared";
import { ALL, dayDate } from "../lib/sync/facts-shared";
import { lineCosts, LAST_YEAR_OFFSET_DAYS, type OrderPlanData, type PlanSupplierInfo, type PlanVariantInfo } from "../lib/order-plan-shared";
import { clearOrderPlanCache, forgetOrderPlan, planCache } from "./plan-cache.server";
import { applyHolds, holdBatches, type PlanHold } from "../lib/deferral-shared";
import { openOrderPayments, readLandedPct, readPaymentTerms, withPayments, type CommittedPayment, type PaymentTerms, type SupplierMoney } from "../lib/cash-shared";
import { readLeadStats, type LeadStats } from "../lib/lead-time-shared";
import { localDate } from "../lib/sync/store-time-shared";
import { firstSaleRows } from "./fact-days.server";
import { kehaOrdersById, kehaPlanOrders, shopBasics, staleDraftCount, type KehaPlanOrder } from "./reorder.server";

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};

const DAY_MS = 86_400_000;

/** Per variant: each Keha order touching it and its units still to arrive (closed orders: what was left). */
function kehaOrdersByVariant(orders: readonly KehaPlanOrder[]): Map<string, { o: KehaPlanOrder; remaining: number }[]> {
  const out = new Map<string, { o: KehaPlanOrder; remaining: number }[]>();
  for (const o of orders) {
    const per = new Map<string, number>();
    for (const l of o.lines) per.set(l.variantId, (per.get(l.variantId) ?? 0) + lineRemaining(l));
    for (const [v, remaining] of per) (out.get(v) ?? out.set(v, []).get(v)!).push({ o, remaining });
  }
  return out;
}

/** One variant's Keha orders as kehaSinceRun reads them, against the metric's run time. */
function kehaNow(list: readonly { o: KehaPlanOrder; remaining: number }[] | undefined, runAt: Date, now: Date): Map<string, KehaOrderNow> {
  const out = new Map<string, KehaOrderNow>();
  for (const { o, remaining } of list ?? []) {
    const closedAt = o.status === "received" ? o.receivedAt : o.status === "cancelled" ? o.cancelledAt : null;
    out.set(o.id, {
      counts: poCountsAsOrdered(o, now),
      sent: o.status === "sent" || o.status === "confirmed",
      remaining,
      closedSinceRun: !!closedAt && closedAt.getTime() >= runAt.getTime() && !!o.sentAt && o.sentAt.getTime() <= runAt.getTime(),
    });
  }
  return out;
}

/**
 * The supplier's own order cycle (Settings → Suppliers "Order every … days") replaces the cycle the
 * nightly run stored, so a changed cycle applies at once: order quantities cover lead time + that
 * cycle (forward plan H = lead + cycle). The next run stores it itself (compute reads the supplier).
 */
export function withSupplierCycle<I extends { cycleDays: number }>(input: I, supplier: { orderCycleDays?: number | null } | null): I {
  const own = supplier?.orderCycleDays;
  return typeof own === "number" && Number.isInteger(own) && own >= 1 ? { ...input, cycleDays: own } : input;
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

/** Products with a variant marked "Don't reorder" (tracked, not bundles: the plan's population). */
async function noReorderProducts(shop: string): Promise<number> {
  const rows = await prisma.variant.findMany({ where: { shop, noReorder: true, tracked: true, isBundle: false }, select: { productId: true } });
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
  orderCycleDays: true,
  minOrderValue: true,
  minOrderScope: true,
  exchangeRate: true,
  depositPercent: true,
  balanceDue: true,
  balanceDays: true,
  landedCostPercent: true,
  leadSamples: true,
  leadPromisedDays: true,
  leadActualDays: true,
  leadDelayDays: true,
  leadSigmaDays: true,
  leadOnTimeShare: true,
  leadMedianDays: true,
  leadP80Days: true,
  leadMedianDelayDays: true,
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

const METRIC_SELECT = { variantId: true, status: true, rate: true, sigma: true, orderQty: true, orderBy: true, daysLeft: true, neverRunsOut: true, inputs: true, computedAt: true } as const;

export type PlanSupplierRow = SupplierLite & {
  email: string | null;
  currency: string | null;
  /** Payment terms (lib/cash-shared readPaymentTerms); null = everything paid when ordering. */
  terms?: PaymentTerms | null;
  /** Freight + duty, % of the goods; null = none. */
  landedPct?: number | null;
  /** Measured lead time; null = nothing measured. */
  leadStats?: LeadStats | null;
};

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
    orderCycleDays: s.orderCycleDays ?? null,
    minOrderValue: num(s.minOrderValue),
    minOrderScope: readMinOrderScope(s.minOrderScope),
    exchangeRate: num(s.exchangeRate),
    terms: readPaymentTerms(s),
    landedPct: readLandedPct(s.landedCostPercent),
    leadSamples: s.leadSamples ?? null,
    leadSigmaDays: s.leadSigmaDays ?? null,
    leadStats: readLeadStats(s),
  }));
}

/** Per variant, for Products and Order now: the plan's order-by date and why it can't be planned. */
export type PlanVariantState = {
  deadline: DayKey | null;
  skip: PlanSkip | null;
  supplierKey: string;
  noReorder: boolean;
  /** Already late (stock at arrival of an order placed today below safety); with deadline null: out, run-out day unknown. */
  overdue?: boolean;
};

export type OrderPlanOptions = {
  /** "online" (default) or a Location.id (Pro location views). */
  scope?: string;
  /** Also read last year's sales in each order's weeks (Order now, Next 13 weeks). */
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
  // The run the stored metrics come from: Keha orders closed since then are read too (H2).
  const run = await prisma.variantMetric.aggregate({ where: { shop, scope }, _min: { computedAt: true } });
  const firstRun = run?._min?.computedAt;
  const closedSince = firstRun instanceof Date ? firstRun : new Date(now.getTime() - 2 * DAY_MS);
  const [kehaRead, supplierRows, staleDrafts] = await Promise.all([
    kehaPlanOrders(shop, closedSince),
    planSuppliers(shop),
    staleDraftCount(shop, now),
  ]);
  // Open Keha units that still count (sent, confirmed, drafts up to 14 days old): the one rule.
  const onOrderAll = onOrderByVariant(kehaRead.orders, { now, transitOf: (id) => kehaRead.transit.get(id) });
  const kehaOrders = new Map(kehaRead.orders.map((o) => [o.id, o]));
  const withKeha = [...new Set([...onOrderAll.keys(), ...kehaRead.orders.flatMap((o) => o.lines.map((l) => l.variantId))])];
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
    // Can't be planned: too little history, dead, or out of stock with no sales pace (2026-10-17:
    // an Out variant with "—" sales/day has no order and no order-by date — count it, don't drop it).
    prisma.variantMetric.findMany({
      where: { shop, scope, OR: [{ status: { in: ["dead", "not_enough_data"] } }, { status: "out", rate: null }] },
      select: { variantId: true, status: true },
    }),
  ]);
  const metrics = new Map(metricRows.map((m) => [m.variantId, m]));
  const ids = [...metrics.keys()];
  // Orders a metric counted that aren't open any more nor closed since the window above (deleted,
  // or closed before it): read by id; still missing = deleted.
  const missing = [...new Set(metricRows.flatMap((m) => (readKehaShares(m.inputs) ?? []).map((x) => x.po)))].filter((id) => !kehaOrders.has(id));
  for (const o of await kehaOrdersById(shop, missing)) kehaOrders.set(o.id, o);
  const kehaByVariant = kehaOrdersByVariant([...kehaOrders.values()]);
  const [variantRows, dead, notReordered] = await Promise.all([
    ids.length ? prisma.variant.findMany({ where: { shop, id: { in: ids }, tracked: true, isBundle: false }, select: VARIANT_SELECT }) : Promise.resolve([]),
    productCount(shop, unplannable.filter((m) => m.status === "dead").map((m) => m.variantId)),
    // L1: counted from the catalog, not from the metrics read above — compute gives a "Don't
    // reorder" variant no order and no order-by date, so its metric is never read here.
    noReorderProducts(shop),
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
  const storeCur = basics.currency.toUpperCase();
  for (const v of variants) {
    const m = metrics.get(v.id);
    if (!m) continue;
    const supplier = supplierFor(v, supplierRows);
    const key = supplier ? supplierGroupKey(supplier.id) : vendorGroupKey(v.vendor);
    if (v.noReorder) {
      state.set(v.id, { deadline: null, skip: null, supplierKey: key, noReorder: true });
      continue;
    }
    const style = supplier?.minOrderScope === "product";
    const pack = casePackFor(v.caseQty, supplier);
    // Keha orders since the run (H2): units added (drafts, sent since) arrive after one lead time;
    // units closed short / cancelled / deleted come out of the incoming now.
    const since = kehaSinceRun(m.inputs, kehaNow(kehaByVariant.get(v.id), m.computedAt ?? closedSince, now));
    const fRate = m.rate !== null ? m.rate * (inputNum(m.inputs, "seasonal") ?? 1) * (inputNum(m.inputs, "trend") ?? 1) : null;
    const costs = lineCosts(num(v.cost), v.costCurrency, storeCur, supplier?.currency ?? null, supplier?.exchangeRate ?? null);
    specs.push({
      variantId: v.id,
      productId: v.productId,
      supplierKey: key,
      unitCost: costs.store,
      weight: fRate ?? 0,
      input: withSupplierCycle(
        forwardInputFromMetric(m, { today, pack, moq: style ? null : (supplier?.minOrder ?? null), notCounted: since.notCounted, removed: since.removed, days }),
        supplier,
      ),
    });
    if (!suppliers[key]) {
      const supCur = (supplier?.currency || basics.currency).toUpperCase();
      const minValue = supplier?.minOrderValue ?? null;
      const minValueStore = minValue === null ? null : supCur === storeCur ? minValue : toStoreCurrency(minValue, supplier?.exchangeRate);
      suppliers[key] = supplier
        ? supplierInfoOf(supplier, storeCur)
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
            orderCycleDays: null,
          };
      rules[key] = {
        styleMin: style ? (supplier?.minOrder ?? null) : null,
        minTotal: supplier?.minOrderTotal ?? null,
        minValue: minValueStore,
      };
    }
    const cyc = inputNum(m.inputs, "cycleDays");
    const info = suppliers[key]!;
    // The supplier's own order cycle wins; otherwise the longest cycle its products were computed with.
    if (!info.orderCycleDays && cyc !== null && (info.cycleDays === null || info.cycleDays === undefined || cyc > info.cycleDays)) info.cycleDays = cyc;
  }

  const plan = planStore(specs, rules, today);
  // Rows written before the plan's inputs existed can't be projected: they keep compute's date.
  const storedBy = (id: string) => {
    const d = metrics.get(id)?.orderBy;
    return d instanceof Date ? d.toISOString().slice(0, 10) : null;
  };
  for (const s of specs) {
    const p = plan.variants.get(s.variantId);
    // A projected variant's null date is the plan's answer (never runs low, or already out with
    // no known run-out day — M3): only rows the plan can't project keep compute's date.
    const deadline = p?.projected ? p.deadline : (p?.deadline ?? (p?.skip ? null : storedBy(s.variantId)));
    state.set(s.variantId, { deadline, skip: p?.skip ?? null, supplierKey: s.supplierKey, noReorder: false, overdue: !!p?.overdue });
  }
  const events = plan.events;
  // Fit to budget → Apply (merchant audit 2026-10-18): orders the merchant moved to next month wait
  // for their day — with their arrival and payments — on every screen that reads the plan. The
  // budget is planned on the online pool, so the holds apply there.
  const holds = scope === METRIC_SCOPE ? await readPlanHolds(shop, today) : [];
  applyHolds(events, holds, today);
  // Supplier module: freight + duty and the days each line is paid (payment terms).
  withPayments(events, moneyOf(suppliers));
  for (const e of events) {
    if (e.deadline !== null || plan.variants.get(e.variantId)?.projected) continue;
    e.deadline = storedBy(e.variantId);
    e.overdue = e.deadline !== null && e.deadline < today && e.orderBy === today;
  }
  if (opts.lastYear && events.length) await addLastYear(shop, today, events, byId);

  const variantInfo: Record<string, PlanVariantInfo> = {};
  const withOrders = new Set(events.map((e) => e.variantId));
  // Not enough history, or out with no sales pace and no order from the plan: "can't be planned yet".
  const noData = await productCount(
    shop,
    unplannable.filter((m) => m.status === "not_enough_data" || (m.status === "out" && !withOrders.has(m.variantId))).map((m) => m.variantId),
  );
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
  // Still to pay on orders already sent / confirmed (cash committed).
  const committed = committedPayments([...kehaOrders.values()], supplierRows, suppliers, { today, timezone: basics.timezone, leadTimeDays: basics.leadTimeDays, storeCurrency: storeCur, transit: kehaRead.transit });
  return {
    data: {
      today,
      currency: basics.currency,
      timezone: basics.timezone,
      events,
      committed,
      budget: basics.monthlyBudget ?? null,
      variants: variantInfo,
      suppliers,
      suppliersSetUp: supplierRows.length > 0,
      cantPlan: { noData, dead },
      batches: plan.batches,
      belowMinimum: (plan.belowMinimum ?? []).map((b) => ({ ...b, productTitle: byId.get(b.variantIds[0]!)?.productTitle ?? "" })),
      staleDrafts,
      notReordered,
      trendMode: basics.trendMode,
      holds: holdBatches(holds, today, (key) => suppliers[key]?.name ?? ""),
    },
    state,
    suppliers: supplierRows,
  };
}

/** A supplier (Settings → Suppliers) as the plan's supplier info: its terms, minimums and money fields. */
export function supplierInfoOf(supplier: PlanSupplierRow, storeCurrency: string): PlanSupplierInfo {
  const storeCur = storeCurrency.toUpperCase();
  const supCur = (supplier.currency || storeCur).toUpperCase();
  const minValue = supplier.minOrderValue ?? null;
  return {
    key: supplierGroupKey(supplier.id),
    kind: "supplier",
    supplierId: supplier.id,
    name: supplier.name,
    currency: supCur,
    exchangeRate: supplier.exchangeRate ?? null,
    minOrderTotal: supplier.minOrderTotal ?? null,
    minOrderValue: minValue,
    minOrderValueStore: minValue === null ? null : supCur === storeCur ? minValue : toStoreCurrency(minValue, supplier.exchangeRate),
    minOrder: supplier.minOrder ?? null,
    minOrderScope: supplier.minOrderScope ?? "variant",
    leadTimeDays: supplier.leadTimeDays,
    leadTimeSource: "supplier",
    hasEmail: !!supplier.email,
    cycleDays: supplier.orderCycleDays ?? null,
    orderCycleDays: supplier.orderCycleDays ?? null,
    ...supplierMoneyInfo(supplier),
  };
}

/** The money fields of a supplier for the plan's supplier info (terms, landed %, transit, measured lead time). */
function supplierMoneyInfo(s: PlanSupplierRow): Pick<PlanSupplierInfo, "terms" | "landedPct" | "transitDays" | "leadStats"> {
  return { terms: s.terms ?? null, landedPct: s.landedPct ?? null, transitDays: s.transitDays ?? null, leadStats: s.leadStats ?? null };
}

function moneyOf(suppliers: Readonly<Record<string, PlanSupplierInfo>>): Record<string, SupplierMoney> {
  const out: Record<string, SupplierMoney> = {};
  for (const [key, s] of Object.entries(suppliers)) out[key] = { terms: s.terms ?? null, landedPct: s.landedPct ?? null, transitDays: s.transitDays ?? null };
  return out;
}

/**
 * Cash committed: what is still to pay on Keha orders already sent or confirmed (lib/cash-shared
 * openOrderPayments) — their balance and freight + duty, from the supplier's terms. Lines are in the
 * store's currency (Shopify cost). Orders without a supplier have no terms (nothing left to pay).
 * Shopify purchase orders are left out: their payment terms live in Shopify. A supplier with only
 * committed payments gets its name in `suppliers`.
 */
function committedPayments(
  orders: readonly KehaPlanOrder[],
  rows: readonly PlanSupplierRow[],
  suppliers: Record<string, PlanSupplierInfo>,
  x: { today: DayKey; timezone: string; leadTimeDays: number; storeCurrency: string; transit: Map<string, number | null> },
): CommittedPayment[] {
  const out: CommittedPayment[] = [];
  for (const o of orders) {
    if ((o.status !== "sent" && o.status !== "confirmed") || !o.supplierId || !o.sentAt) continue;
    const s = rows.find((r) => r.id === o.supplierId);
    if (!s || (!s.terms && !s.landedPct)) continue;
    const sentDay = localDate(o.sentAt, x.timezone);
    const at = poArrival(o, x.transit.get(o.supplierId) ?? s.transitDays ?? null);
    const arrives = at ? at.toISOString().slice(0, 10) : addDays(sentDay, s.leadTimeDays ?? x.leadTimeDays);
    let goods = 0;
    let known = false;
    for (const l of o.lines) {
      if (l.unitCost === null || !(l.qty > 0)) continue;
      goods += l.unitCost * l.qty;
      known = true;
    }
    const key = supplierGroupKey(s.id);
    const pays = openOrderPayments(
      {
        id: o.id,
        number: o.number ?? "",
        supplierKey: key,
        sentDay,
        shipDay: o.confirmedShipDate ? o.confirmedShipDate.toISOString().slice(0, 10) : null,
        arrives,
        goods: known ? Math.round(goods * 100) / 100 : null,
        money: { terms: s.terms ?? null, landedPct: s.landedPct ?? null, transitDays: x.transit.get(o.supplierId) ?? s.transitDays ?? null },
      },
      x.today,
    );
    if (!pays.length) continue;
    out.push(...pays);
    if (!suppliers[key]) suppliers[key] = supplierInfoOf(s, x.storeCurrency);
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.number.localeCompare(b.number) || a.kind.localeCompare(b.kind));
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
    facts.salesDaily.groupBy({
      by: ["variantId", "day"],
      where: { shop, variantId: { in: ids }, locationKey: ALL, day: { gte: dayDate(lo), lt: dayDate(hi) } },
      _sum: { sold: true },
    }),
    // First channel-view sale per variant: stored days, not the whole history (DB scale #3).
    firstSaleRows(shop, ids),
    facts.salesDaily.aggregate({ where: { shop, locationKey: ALL }, _min: { day: true } }),
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

// ── Cache for the screens that read the whole plan on every page load (Products, Sidekick) ──
//
// Products sorts every variant by the plan's order-by date, so each page load needs the whole
// forward plan (~0.25 s of maths for 3,000 variants, plus the reads). The result only changes
// when something the plan reads changes, so it is kept per shop + scope and reused while its
// FINGERPRINT is the same: the store's day and settings, the latest metric run (computedAt and how
// many rows it has written so far), the
// catalog, suppliers and Keha orders (newest updatedAt and counts; each open order's status,
// version and whether it still counts as ordered at `now`). Anything that changes one of them
// recomputes; PLAN_CACHE_TTL_MS caps the age anyway. One process, bounded (PLAN_CACHE_MAX). The
// writes that change what the plan reads also forget the shop's entries (forgetOrderPlan, L2).

const PLAN_CACHE_TTL_MS = 10 * 60 * 1000;
const PLAN_CACHE_MAX = 100;
export { clearOrderPlanCache, forgetOrderPlan };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "");

/** null = nothing to key on (no metric run yet): computed fresh every time. */
async function planFingerprint(shop: string, scope: string, now: Date): Promise<string | null> {
  const [shopRow, run, metric, metricCount, variant, variantCount, supplier, supplierCount, orders] = await Promise.all([
    prisma.shop.findUnique({ where: { domain: shop }, select: { settings: true, currency: true, timezone: true, lastNightlyAt: true } }),
    // The latest compute run (DB scale: rows are rewritten only when their content changes, so
    // the run — when it started, how many rows it confirmed and changed so far, whether it
    // finished — is what moves; rows written before MetricRun existed fall back to computedAt).
    prisma.metricRun.findUnique({ where: { shop_scope: { shop, scope } }, select: { startedAt: true, finishedAt: true, rows: true, changed: true } }),
    prisma.variantMetric.aggregate({ where: { shop, scope }, _max: { computedAt: true } }),
    prisma.variantMetric.count({ where: { shop, scope } }),
    prisma.variant.aggregate({ where: { shop }, _max: { updatedAt: true } }),
    prisma.variant.count({ where: { shop } }),
    prisma.supplier.aggregate({ where: { shop }, _max: { updatedAt: true } }),
    prisma.supplier.count({ where: { shop } }),
    prisma.purchaseOrder.findMany({
      where: { shop, source: "keha", status: { in: [...REORDER_HOLD_STATUSES] } },
      select: { id: true, status: true, updatedAt: true, createdAt: true },
    }),
  ]);
  if (!metric._max.computedAt && !run) return null;
  // L2: how far the latest run got. A run writes its rows in batches and sweeps the rows of
  // variants it no longer computes at the end: MetricRun's rows / changed grow with every batch,
  // finishedAt is set by the sweep (and metricCount changes with it), and the newest computedAt
  // moves with every changed row — so a plan cached from a half-written run is never reused once
  // another batch lands or the run finishes.
  const runKey = run ? [iso(run.startedAt), iso(run.finishedAt), run.rows, run.changed] : [await prisma.variantMetric.count({ where: { shop, scope, computedAt: metric._max.computedAt! } })];
  return JSON.stringify([
    todayIn(shopRow?.timezone ?? "UTC", now),
    shopRow?.settings ?? null,
    shopRow?.currency ?? null,
    iso(shopRow?.lastNightlyAt),
    iso(metric._max.computedAt),
    runKey,
    metricCount,
    iso(variant._max.updatedAt),
    variantCount,
    iso(supplier._max.updatedAt),
    supplierCount,
    orders
      .map((o) => `${o.id}:${o.status}:${iso(o.updatedAt)}:${poCountsAsOrdered(o, now) ? 1 : 0}`)
      .sort(),
  ]);
}

/**
 * computeOrderPlan, reused while nothing it reads changed (see above). For Products and Sidekick;
 * Order now, the Dashboard and the email compute fresh.
 */
export async function cachedOrderPlan(shop: string, now: Date = new Date(), opts: { scope?: string } = {}): Promise<OrderPlanDetail> {
  const scope = opts.scope ?? METRIC_SCOPE;
  const key = `${shop}|${scope}`;
  const fingerprint = await planFingerprint(shop, scope, now);
  if (fingerprint === null) return computeOrderPlan(shop, now, { scope });
  const hit = planCache.get(key);
  if (hit && hit.fingerprint === fingerprint && now.getTime() - hit.at >= 0 && now.getTime() - hit.at < PLAN_CACHE_TTL_MS) return hit.value;
  const value = computeOrderPlan(shop, now, { scope });
  planCache.delete(key);
  planCache.set(key, { fingerprint, at: now.getTime(), value });
  // A failed computation is not kept.
  value.catch(() => {
    if (planCache.get(key)?.value === value) planCache.delete(key);
  });
  while (planCache.size > PLAN_CACHE_MAX) planCache.delete(planCache.keys().next().value!);
  return value;
}

/** The forward plan (Dashboard, Order plan tabs, Products, Sidekick, the Monday email). */
export async function loadOrderPlan(shop: string, now: Date = new Date(), opts: OrderPlanOptions = {}): Promise<OrderPlanData> {
  return (await computeOrderPlan(shop, now, opts)).data;
}

/** The shop's Fit to budget holds still in force (PlanDeferral, lib/deferral-shared). */
async function readPlanHolds(shop: string, today: DayKey): Promise<PlanHold[]> {
  const rows = await prisma.planDeferral.findMany({ where: { shop, until: { gt: new Date(`${today}T00:00:00Z`) } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return rows.map((r) => ({
    batch: r.batch,
    month: r.month,
    variantId: r.variantId,
    supplierKey: r.supplierKey,
    fromDay: day(r.fromDay),
    until: day(r.until),
    qty: r.qty,
    amount: Number(String(r.amount)),
  }));
}
