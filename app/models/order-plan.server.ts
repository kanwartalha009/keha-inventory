/**
 * Order plan (Kanwar 2026-10-17): the forward order plan for the online stock pool, from the
 * latest VariantMetric run (engine/forward-plan-shared). Database only, no Shopify calls.
 *
 * Read per variant: the stored metric (rate, σ, status, orderQty and its inputs: seasonal and
 * trend, the seasonal shape, safety, lead time, cycle, on hand, incoming with dates, orderNeed),
 * the supplier (Settings → Suppliers, else matched by vendor) for the case pack and minimum, and
 * the open Keha units compute did not count yet (drafts, orders sent since the run) — exactly
 * what Order now reads, so day-0 orders are Order now's lines.
 *
 * Only metrics that can produce an order inside the 13 weeks are read: an order today
 * (orderQty > 0) or an order-by date up to the end of the calendar. Later orders are always on
 * or after the order-by date, and open Keha units only move it later.
 */
import prisma from "../db.server";
import { addDays, type DayKey } from "../lib/engine/dates-shared";
import { eventsOf, forwardInputFromMetric, planDays, planEnd, planVariant, type PlanEvent } from "../lib/engine/forward-plan-shared";
import { METRIC_SCOPE } from "../lib/products-shared";
import { REORDER_HOLD_STATUSES } from "../lib/purchase-order-shared";
import { supplierGroupKey, unitCostIn, vendorGroupKey } from "../lib/reorder-shared";
import { casePackFor, supplierFor } from "../lib/supplier-shared";
import { todayIn } from "../lib/dashboard-shared";
import { dayDate } from "../lib/sync/facts-shared";
import type { OrderPlanData, PlanSupplierInfo, PlanVariantInfo } from "../lib/order-plan-shared";
import { kehaOnOrder, shopBasics } from "./reorder.server";

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

/** Distinct products of these variants. */
async function productCount(shop: string, variantIds: string[]): Promise<number> {
  if (!variantIds.length) return 0;
  const rows = await prisma.variant.findMany({ where: { shop, id: { in: variantIds } }, select: { productId: true } });
  return new Set(rows.map((r) => r.productId)).size;
}

export async function loadOrderPlan(shop: string, now: Date = new Date()): Promise<OrderPlanData> {
  const basics = await shopBasics(shop);
  const today: DayKey = todayIn(basics.timezone, now);
  const days = planDays(today);
  const [metrics, unplannable, supplierRows] = await Promise.all([
    prisma.variantMetric.findMany({
      where: {
        shop,
        scope: METRIC_SCOPE,
        status: { notIn: ["dead", "not_enough_data"] },
        OR: [{ orderQty: { gt: 0 } }, { orderBy: { lte: dayDate(addDays(planEnd(today), 1)) } }],
      },
      select: { variantId: true, status: true, rate: true, sigma: true, orderQty: true, daysLeft: true, neverRunsOut: true, inputs: true },
    }),
    prisma.variantMetric.findMany({
      where: { shop, scope: METRIC_SCOPE, status: { in: ["dead", "not_enough_data"] } },
      select: { variantId: true, status: true },
    }),
    prisma.supplier.findMany({
      where: { shop },
      select: { id: true, name: true, leadTimeDays: true, minOrder: true, minOrderTotal: true, casePack: true, vendorMatch: true, currency: true },
    }),
  ]);
  const ids = metrics.map((m) => m.variantId);
  const [variants, onOrder, noData, dead] = await Promise.all([
    ids.length
      ? prisma.variant.findMany({
          where: { shop, id: { in: ids }, tracked: true, isBundle: false },
          select: {
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
          },
        })
      : Promise.resolve([]),
    kehaOnOrder(shop, REORDER_HOLD_STATUSES, ids),
    productCount(shop, unplannable.filter((m) => m.status === "not_enough_data").map((m) => m.variantId)),
    productCount(shop, unplannable.filter((m) => m.status === "dead").map((m) => m.variantId)),
  ]);

  const metricOf = new Map(metrics.map((m) => [m.variantId, m]));
  const events: PlanEvent[] = [];
  const variantInfo: Record<string, PlanVariantInfo> = {};
  const suppliers: Record<string, PlanSupplierInfo> = {};
  for (const v of variants) {
    const m = metricOf.get(v.id);
    if (!m) continue;
    const supplier = supplierFor(v, supplierRows);
    const key = supplier ? supplierGroupKey(supplier.id) : vendorGroupKey(v.vendor);
    const notCounted = Math.max(0, (onOrder.get(v.id)?.qty ?? 0) - kehaCounted(m.inputs));
    const plan = planVariant(
      forwardInputFromMetric(m, { today, pack: casePackFor(v.caseQty, supplier), moq: supplier?.minOrder ?? null, notCounted, days }),
    );
    if (!plan.orders.length) continue;
    events.push(...eventsOf(plan, { variantId: v.id, productId: v.productId, supplierKey: key, unitCost: unitCostIn(num(v.cost), v.costCurrency, basics.currency, basics.currency) }));
    suppliers[key] ??= supplier
      ? { key, kind: "supplier", supplierId: supplier.id, name: supplier.name }
      : { key, kind: "vendor", supplierId: null, name: (v.vendor ?? "").trim() };
    const price = num(v.price);
    const fRate = m.rate !== null ? m.rate * (inputNum(m.inputs, "seasonal") ?? 1) * (inputNum(m.inputs, "trend") ?? 1) : null;
    variantInfo[v.id] = {
      variantId: v.id,
      productId: v.productId,
      productTitle: v.productTitle,
      variantTitle: v.variantTitle,
      sku: v.sku,
      image: v.image,
      daysLeft: m.daysLeft,
      neverRunsOut: m.neverRunsOut,
      deadline: plan.deadline,
      valuePerDay: fRate !== null && price !== null ? fRate * price : null,
    };
  }
  events.sort((a, b) => a.orderBy.localeCompare(b.orderBy) || a.supplierKey.localeCompare(b.supplierKey) || (a.variantId < b.variantId ? -1 : 1));
  return {
    today,
    currency: basics.currency,
    timezone: basics.timezone,
    events,
    variants: variantInfo,
    suppliers,
    suppliersSetUp: supplierRows.length > 0,
    cantPlan: { noData, dead },
  };
}
