/**
 * Reorder plan and purchase orders (spec §5.3, J3). Database only.
 *
 * Suggestions come from VariantMetric (scope "online", Phase 1) with
 * orderQty > 0, minus units already on an open Keha order (draft, sent,
 * confirmed — the engine can't see Keha orders: they never reach Shopify),
 * then the supplier's minimums (lib/reorder-shared).
 *
 * Location view (Pro, phase 3; `scope` = a warehouse / store Location.id):
 * store-level replenishment from that location's metrics and its StockNow,
 * grouped by supplier the same way. Keha orders carry no destination
 * location, so open Keha units are subtracted in every view (never order the
 * same units twice); an order created from a location view records the
 * location's name in its note.
 *
 * Incoming, and why nothing is counted twice:
 *  - StockNow.incoming is Shopify's own "incoming" (transfers, including the
 *    ones linked to Shopify purchase orders).
 *  - Keha orders live only in our database (Shopify has no API to create a
 *    purchase order), so they are never in StockNow.incoming. They are shown
 *    separately as "On order with Keha", never added to Shopify's number.
 *  - Purchase orders read from Shopify are listed under Open orders only;
 *    their units are not added anywhere (Shopify already counts them).
 */
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { readSettings } from "../lib/settings-shared";
import { POOL_LOCATION_SELECT, poolLocationIds } from "../lib/compute-shared";
import { METRIC_SCOPE } from "../lib/products-shared";
import { readPoLines, poArrival, type PoLine } from "../lib/supplier-shared";
import { forwardInputFromMetric, planVariant } from "../lib/engine/forward-plan-shared";
import { todayIn } from "../lib/dashboard-shared";
import {
  buildReorderGroups,
  type ReorderGroup,
  type ReorderMetricIn,
  type ReorderVariantIn,
} from "../lib/reorder-shared";
import {
  REORDER_HOLD_STATUSES,
  canTransition,
  nextPoNumber,
  poTotals,
  sentDates,
  type PoStatus,
} from "../lib/purchase-order-shared";

const dayOf = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};

export type ShopBasics = { currency: string; timezone: string; locale: string; leadTimeDays: number };

export async function shopBasics(shop: string): Promise<ShopBasics> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { currency: true, timezone: true, locale: true, settings: true } });
  return {
    currency: row?.currency ?? "USD",
    timezone: row?.timezone ?? "UTC",
    locale: row?.locale ?? "en",
    leadTimeDays: readSettings(row?.settings).leadTimeDays,
  };
}

async function poolIds(shop: string): Promise<string[]> {
  const locations = await prisma.location.findMany({ where: { shop }, select: POOL_LOCATION_SELECT });
  return poolLocationIds(locations);
}

/** On-hand and incoming (online pool) per variant. */
export async function poolStock(shop: string, ids: string[]): Promise<Map<string, { onHand: number | null; incoming: number | null }>> {
  const out = new Map<string, { onHand: number | null; incoming: number | null }>();
  if (!ids.length) return out;
  const pool = await poolIds(shop);
  if (!pool.length) return out;
  const rows = await prisma.stockNow.groupBy({
    by: ["variantId"],
    where: { shop, variantId: { in: ids }, locationId: { in: pool } },
    _sum: { onHand: true, incoming: true },
  });
  for (const r of rows) out.set(r.variantId, { onHand: r._sum.onHand ?? null, incoming: r._sum.incoming ?? null });
  return out;
}

/** On-hand and incoming at one location per variant (location view). */
export async function locationStock(
  shop: string,
  ids: string[],
  locationId: string,
): Promise<Map<string, { onHand: number | null; incoming: number | null }>> {
  const out = new Map<string, { onHand: number | null; incoming: number | null }>();
  if (!ids.length) return out;
  const rows = await prisma.stockNow.findMany({
    where: { shop, variantId: { in: ids }, locationId },
    select: { variantId: true, onHand: true, incoming: true },
  });
  for (const r of rows) out.set(r.variantId, { onHand: r.onHand, incoming: r.incoming });
  return out;
}

/** VariantMetric.inputs.kehaOnOrder (compute, task 2.1): Keha units already in orderQty. */
function kehaCountedOf(inputs: unknown): number {
  const v = inputs && typeof inputs === "object" ? (inputs as Record<string, unknown>).kehaOnOrder : undefined;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** VariantMetric.inputs.orderNeed (engine): the unrounded need; null when absent (older rows). */
function needOf(inputs: unknown): number | null {
  const v = inputs && typeof inputs === "object" ? (inputs as Record<string, unknown>).orderNeed : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Units on open Keha orders per variant (ordered − received) and the earliest
 * arrival. `statuses`: draft/sent/confirmed for the Reorder suggestions;
 * sent/confirmed for Products ("On order with Keha").
 */
export async function kehaOnOrder(
  shop: string,
  statuses: readonly string[],
  variantIds?: string[],
): Promise<Map<string, { qty: number; arrival: string | null }>> {
  const out = new Map<string, { qty: number; arrival: string | null }>();
  if (variantIds && !variantIds.length) return out;
  const orders = await prisma.purchaseOrder.findMany({
    where: { shop, source: "keha", status: { in: [...statuses] } },
    select: { lines: true, confirmedShipDate: true, expectedDate: true },
  });
  const wanted = variantIds ? new Set(variantIds) : null;
  for (const o of orders) {
    const arrival = dayOf(poArrival(o));
    for (const l of readPoLines(o.lines)) {
      if (wanted && !wanted.has(l.variantId)) continue;
      const left = Math.max(0, l.qty - (l.received ?? 0));
      if (!left) continue;
      const cur = out.get(l.variantId) ?? { qty: 0, arrival: null };
      cur.qty += left;
      if (arrival && (!cur.arrival || arrival < cur.arrival)) cur.arrival = arrival;
      out.set(l.variantId, cur);
    }
  }
  return out;
}

export type OpenOrderRow = {
  id: string;
  number: string;
  source: "keha" | "shopify";
  status: PoStatus;
  supplierName: string | null;
  units: number;
  cost: number | null;
  currency: string | null;
  arrival: string | null;
  createdAt: string;
};

function toOpenRow(o: {
  id: string;
  number: string;
  source: string;
  status: string;
  supplierName: string | null;
  lines: unknown;
  currency: string | null;
  confirmedShipDate: Date | null;
  expectedDate: Date | null;
  createdAt: Date;
}): OpenOrderRow {
  const totals = poTotals(readPoLines(o.lines));
  return {
    id: o.id,
    number: o.number,
    source: o.source === "shopify" ? "shopify" : "keha",
    status: o.status as PoStatus,
    supplierName: o.supplierName,
    units: totals.units,
    cost: totals.cost,
    currency: o.currency,
    arrival: dayOf(poArrival(o)),
    createdAt: o.createdAt.toISOString(),
  };
}

/** Keha drafts / sent / confirmed and Shopify orders that are ordered but not received. */
export async function openOrders(shop: string): Promise<OpenOrderRow[]> {
  const rows = await prisma.purchaseOrder.findMany({
    where: {
      shop,
      OR: [
        { source: "keha", status: { in: [...REORDER_HOLD_STATUSES] } },
        { source: "shopify", status: "sent" },
      ],
    },
    orderBy: [{ createdAt: "desc" }],
    take: 200,
  });
  return rows.map(toOpenRow);
}

export type ReorderData = {
  groups: ReorderGroup[];
  openOrders: OpenOrderRow[];
  currency: string;
  /** ?variants= ids that aren't tracked variants of this store. */
  missingSelected: number;
};

/**
 * The Reorder screen: suggestions grouped by supplier, and the open orders. `scope`: "online"
 * or a Location.id. `planned`: the Planner's quantities (?variants=id:qty) for those lines.
 */
export async function loadReorder(
  shop: string,
  selected: string[] = [],
  scope: string = METRIC_SCOPE,
  planned: ReadonlyMap<string, number> = new Map(),
  now: Date = new Date(),
): Promise<ReorderData> {
  const basics = await shopBasics(shop);
  const metrics = await prisma.variantMetric.findMany({
    where: { shop, scope, OR: [{ orderQty: { gt: 0 } }, ...(selected.length ? [{ variantId: { in: selected } }] : [])] },
    select: { variantId: true, status: true, sigma: true, orderQty: true, orderBy: true, daysLeft: true, neverRunsOut: true, rate: true, inputs: true },
  });
  const ids = [...new Set([...metrics.map((m) => m.variantId), ...selected])];
  const [variants, suppliers, onOrder, stock, open] = await Promise.all([
    ids.length
      ? prisma.variant.findMany({
          where: { shop, id: { in: ids }, tracked: true, isBundle: false },
          select: {
            id: true,
            productTitle: true,
            variantTitle: true,
            sku: true,
            vendor: true,
            image: true,
            supplierId: true,
            caseQty: true,
            cost: true,
            costCurrency: true,
          },
        })
      : Promise.resolve([]),
    prisma.supplier.findMany({
      where: { shop },
      select: { id: true, name: true, email: true, leadTimeDays: true, minOrder: true, minOrderTotal: true, casePack: true, vendorMatch: true, currency: true },
    }),
    kehaOnOrder(shop, REORDER_HOLD_STATUSES, ids),
    scope === METRIC_SCOPE ? poolStock(shop, ids) : locationStock(shop, ids, scope),
    openOrders(shop),
  ]);
  // One rule with the forward order plan (engine/forward-plan-shared): a variant it can't plan
  // (dead, not enough data, no sales) isn't suggested; the online view shows its order-by date,
  // with the open Keha units compute didn't count yet (location views keep the stored date).
  const today = todayIn(basics.timezone, now);
  const metricMap = new Map<string, ReorderMetricIn>(
    metrics.map((m) => {
      const kehaCounted = kehaCountedOf(m.inputs);
      const notCounted = Math.max(0, (onOrder.get(m.variantId)?.qty ?? 0) - kehaCounted);
      const fwd = planVariant(forwardInputFromMetric(m, { today, pack: null, moq: null, notCounted, days: 0 }));
      return [
        m.variantId,
        {
          orderQty: m.orderQty,
          orderBy: scope === METRIC_SCOPE ? fwd.deadline : dayOf(m.orderBy),
          daysLeft: m.daysLeft,
          neverRunsOut: m.neverRunsOut,
          rate: m.rate,
          kehaCounted,
          need: needOf(m.inputs),
          plannable: fwd.skip === null,
        },
      ];
    }),
  );
  const variantRows: ReorderVariantIn[] = variants.map((v) => ({ ...v, cost: num(v.cost) }));
  const known = new Set(variantRows.map((v) => v.id));
  const groups = buildReorderGroups({
    variants: variantRows,
    metrics: metricMap,
    stock,
    onOrder: new Map([...onOrder].map(([k, v]) => [k, v.qty])),
    suppliers: suppliers.map(({ email, ...s }) => ({ ...s, hasEmail: !!email })),
    storeCurrency: basics.currency,
    defaultLeadTimeDays: basics.leadTimeDays,
    selected: new Set(selected.filter((s) => known.has(s))),
    planned: new Map([...planned].filter(([id]) => known.has(id))),
  });
  return { groups, openOrders: open, currency: basics.currency, missingSelected: selected.filter((s) => !known.has(s)).length };
}

/** A fresh supplier-confirm token: 32 random bytes, base64url (spec §14). */
export function newConfirmToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/**
 * Inserts a Keha order with the next PO-0001 number for the shop. Two orders
 * created at once can pick the same number: the unique (shop, number) index
 * refuses the second, which retries with the next number.
 */
export async function insertWithNumber(
  shop: string,
  data: Omit<Prisma.PurchaseOrderUncheckedCreateInput, "shop" | "number" | "confirmToken">,
  attempts = 5,
): Promise<{ id: string; number: string }> {
  for (let i = 1; ; i++) {
    // Every number of the shop (Keha and Shopify): a Shopify order named "PO-0007" blocks that number too.
    const existing = await prisma.purchaseOrder.findMany({ where: { shop }, select: { number: true } });
    const number = nextPoNumber(existing.map((e) => e.number));
    try {
      return await prisma.purchaseOrder.create({
        data: { ...data, shop, number, confirmToken: newConfirmToken() },
        select: { id: true, number: true },
      });
    } catch (e) {
      if (!isUniqueViolation(e) || i >= attempts) throw e;
    }
  }
}

export type CreateOrderResult = { ok: true; id: string; number: string } | { ok: false; error: "gone" | "empty" };

/**
 * "Create order" for one supplier group (a Draft). The group and its lines
 * are re-read here; the browser only sends quantities, and only for
 * variants of that group.
 */
export async function createOrderFromGroup(
  shop: string,
  groupKey: string,
  quantities: Record<string, number>,
  view: { scope: string; note: string | null } = { scope: METRIC_SCOPE, note: null },
): Promise<CreateOrderResult> {
  const { groups } = await loadReorder(shop, Object.keys(quantities), view.scope);
  const group = groups.find((g) => g.key === groupKey);
  if (!group) return { ok: false, error: "gone" };
  const lines: PoLine[] = [];
  for (const l of group.lines) {
    const qty = quantities[l.variantId] ?? 0;
    if (!(qty > 0)) continue;
    lines.push({ variantId: l.variantId, qty, unitCost: l.unitCost, productTitle: l.productTitle, variantTitle: l.variantTitle, sku: l.sku });
  }
  if (!lines.length) return { ok: false, error: "empty" };
  const created = await insertWithNumber(shop, {
    supplierId: group.supplierId,
    supplierName: group.name || null,
    status: "draft",
    source: "keha",
    lines: lines as unknown as Prisma.InputJsonValue,
    currency: group.currency,
    note: view.note,
  });
  return { ok: true, ...created };
}

export type OrderDetail = {
  id: string;
  number: string;
  source: "keha" | "shopify";
  status: PoStatus;
  supplierId: string | null;
  supplierName: string | null;
  supplier: { name: string; hasEmail: boolean; hidePrices: boolean; leadTimeDays: number } | null;
  lines: PoLine[];
  currency: string | null;
  confirmToken: string;
  confirmExpiresAt: string | null;
  confirmedShipDate: string | null;
  expectedDate: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
};

export async function getOrder(shop: string, id: string): Promise<OrderDetail | null> {
  const o = await prisma.purchaseOrder.findFirst({ where: { id, shop } });
  if (!o) return null;
  const s = o.supplierId
    ? await prisma.supplier.findFirst({
        where: { id: o.supplierId, shop },
        select: { name: true, email: true, hidePrices: true, leadTimeDays: true },
      })
    : null;
  return {
    id: o.id,
    number: o.number,
    source: o.source === "shopify" ? "shopify" : "keha",
    status: o.status as PoStatus,
    supplierId: o.supplierId,
    supplierName: o.supplierName,
    supplier: s ? { name: s.name, hasEmail: !!s.email, hidePrices: s.hidePrices, leadTimeDays: s.leadTimeDays } : null,
    lines: readPoLines(o.lines),
    currency: o.currency,
    confirmToken: o.confirmToken,
    confirmExpiresAt: o.confirmExpiresAt?.toISOString() ?? null,
    confirmedShipDate: dayOf(o.confirmedShipDate),
    expectedDate: dayOf(o.expectedDate),
    sentAt: o.sentAt?.toISOString() ?? null,
    receivedAt: o.receivedAt?.toISOString() ?? null,
    cancelledAt: o.cancelledAt?.toISOString() ?? null,
    createdAt: o.createdAt.toISOString(),
  };
}

/** Prices are hidden from the supplier when the supplier says so — and when it was deleted (safe default). */
export function hidePricesFor(order: Pick<OrderDetail, "supplierId" | "supplier">): boolean {
  return order.supplierId ? (order.supplier?.hidePrices ?? true) : false;
}

export type TransitionResult = { ok: true } | { ok: false; error: "notFound" | "notAllowed" | "changed" };

/**
 * Moves a Keha order to `to` (the merchant confirmed it in the UI). Sending
 * stamps the expected arrival (sent + lead time), the 60-day confirm-link
 * expiry and each line's current on-hand (the auto-receive baseline).
 * Receiving fills each line's received units. Optimistic: the update only
 * applies while the order still has the status it was read with.
 */
export async function transitionOrder(shop: string, id: string, to: PoStatus, now: Date = new Date()): Promise<TransitionResult> {
  const o = await prisma.purchaseOrder.findFirst({
    where: { id, shop },
    select: { status: true, source: true, supplierId: true, lines: true },
  });
  if (!o) return { ok: false, error: "notFound" };
  if (!canTransition(o.status, to, o.source)) return { ok: false, error: "notAllowed" };
  const data: Prisma.PurchaseOrderUpdateManyMutationInput = { status: to };
  const lines = readPoLines(o.lines);
  if (to === "sent") {
    const [basics, supplier] = await Promise.all([
      shopBasics(shop),
      o.supplierId ? prisma.supplier.findFirst({ where: { id: o.supplierId, shop }, select: { leadTimeDays: true } }) : null,
    ]);
    const dates = sentDates(now, supplier?.leadTimeDays ?? basics.leadTimeDays);
    const stock = await poolStock(shop, lines.map((l) => l.variantId));
    data.sentAt = now;
    data.expectedDate = new Date(`${dates.expectedDate}T00:00:00Z`);
    data.confirmExpiresAt = dates.confirmExpiresAt;
    data.lines = lines.map((l) => {
      const base = stock.get(l.variantId)?.onHand;
      return typeof base === "number" ? { ...l, baseOnHand: base } : l;
    }) as unknown as Prisma.InputJsonValue;
  } else if (to === "received") {
    data.receivedAt = now;
    data.lines = lines.map((l) => ({ ...l, received: l.received ?? l.qty })) as unknown as Prisma.InputJsonValue;
  } else if (to === "cancelled") {
    data.cancelledAt = now;
  }
  const r = await prisma.purchaseOrder.updateMany({ where: { id, shop, status: o.status }, data });
  return r.count === 1 ? { ok: true } : { ok: false, error: "changed" };
}
