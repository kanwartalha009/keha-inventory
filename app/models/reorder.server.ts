/**
 * Order plan (Order now) and purchase orders (spec §5.3, J3). Database only.
 *
 * Order now comes from the forward order plan (models/order-plan.server, the same function as
 * the Dashboard): orders due in the next 7 days, after units already on an open Keha order
 * (sent, confirmed, and drafts up to 14 days old — the engine can't see Keha orders: they never
 * reach Shopify) and the supplier's minimums.
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
import { readPoLines, lineRemaining, onOrderByVariant, poArrival, poCountsAsOrdered, type PoLine } from "../lib/supplier-shared";
import { buildOrderNow, type ReorderGroup } from "../lib/reorder-shared";
import { thisWeek } from "../lib/order-plan-shared";
import { todayIn } from "../lib/dashboard-shared";
import { readScenarioResult, scenarioQuantities } from "../lib/planner-shared";
import { computeOrderPlan } from "./order-plan.server";
import {
  REORDER_HOLD_STATUSES,
  applyDraftEdit,
  applyReceipt,
  canTransition,
  nextPoNumber,
  openOrderRows,
  pricingFor,
  poTotals,
  reopenTarget,
  reopenedLines,
  sentDates,
  type OpenOrderListRow,
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

/**
 * On-hand and incoming over the supplier-order pool (countsForOnline) per variant: the "On hand"
 * column and the auto-receive baseline. Planning numbers never read it — they come from the
 * forward plan, which plans from Shopify available (VariantMetric.inputs.onHand, compute).
 */
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

/** Transit days per supplier id (arrival = confirmed ship date + transit; supplier-shared poArrival). */
export async function supplierTransit(shop: string): Promise<Map<string, number | null>> {
  const rows = await prisma.supplier.findMany({ where: { shop }, select: { id: true, transitDays: true } });
  return new Map(rows.map((r) => [r.id, r.transitDays ?? null]));
}

/**
 * Units on open Keha orders per variant (ordered − received) and the earliest
 * arrival (confirmed ship date + the supplier's transit days, else the lead-time
 * estimate). `statuses`: draft/sent/confirmed for the order plan; sent/confirmed
 * for Products ("On order with Keha"). Drafts older than DRAFT_EXPIRY_DAYS (at `opts.now`,
 * default now) no longer count. The rule itself: supplier-shared onOrderByVariant.
 */
export async function kehaOnOrder(
  shop: string,
  statuses: readonly string[],
  variantIds?: string[],
  opts: { now?: Date } = {},
): Promise<Map<string, { qty: number; arrival: string | null }>> {
  if (variantIds && !variantIds.length) return new Map();
  const [orders, transit] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where: { shop, source: "keha", status: { in: [...statuses] } },
      select: { lines: true, confirmedShipDate: true, expectedDate: true, supplierId: true, status: true, createdAt: true },
    }),
    supplierTransit(shop),
  ]);
  return onOrderByVariant(
    orders.map((o) => ({ ...o, lines: readPoLines(o.lines) })),
    { now: opts.now ?? new Date(), transitOf: (id) => transit.get(id), variantIds: variantIds ? new Set(variantIds) : null },
  );
}

/** Keha drafts nobody sent for DRAFT_EXPIRY_DAYS: they no longer net off the order plan. */
export async function staleDraftCount(shop: string, now: Date): Promise<number> {
  const drafts = await prisma.purchaseOrder.findMany({ where: { shop, source: "keha", status: "draft" }, select: { status: true, createdAt: true, lines: true } });
  return drafts.filter((d) => d.createdAt && !poCountsAsOrdered({ status: d.status, createdAt: d.createdAt }, now) && readPoLines(d.lines).some((l) => lineRemaining(l) > 0)).length;
}

export type OpenOrderRow = {
  id: string;
  number: string;
  source: "keha" | "shopify";
  status: PoStatus;
  supplierName: string | null;
  /** Units ordered. */
  units: number;
  /** Units still to arrive (ordered − received; partial receiving). */
  remaining: number;
  /** Value of the units ordered / still to arrive, order currency; null when a cost is missing. */
  cost: number | null;
  remainingCost: number | null;
  currency: string | null;
  /** Confirmed ship date + the supplier's transit days, else the lead-time estimate (poArrival). */
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
}, transitDays?: number | null): OpenOrderRow {
  const lines = readPoLines(o.lines);
  const totals = poTotals(lines);
  const left = poTotals(lines.map((l) => ({ ...l, qty: lineRemaining(l) })));
  return {
    id: o.id,
    number: o.number,
    source: o.source === "shopify" ? "shopify" : "keha",
    status: o.status as PoStatus,
    supplierName: o.supplierName,
    units: totals.units,
    remaining: left.units,
    cost: totals.cost,
    remainingCost: left.cost,
    currency: o.currency,
    arrival: dayOf(poArrival(o, transitDays)),
    createdAt: o.createdAt.toISOString(),
  };
}

/** Keha drafts / sent / confirmed and Shopify orders that are ordered but not received. */
export async function openOrders(shop: string): Promise<OpenOrderRow[]> {
  const [rows, transit] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where: {
        shop,
        OR: [
          { source: "keha", status: { in: [...REORDER_HOLD_STATUSES] } },
          { source: "shopify", status: "sent" },
        ],
      },
      orderBy: [{ createdAt: "desc" }],
      take: 200,
    }),
    supplierTransit(shop),
  ]);
  return rows.map((r) => toOpenRow(r, r.supplierId ? transit.get(r.supplierId) : null));
}

export type ReorderData = {
  groups: ReorderGroup[];
  openOrders: OpenOrderRow[];
  currency: string;
  /** ?variants= ids that aren't tracked variants of this store. */
  missingSelected: number;
  /** Today in the store's time zone (due dates). */
  today?: string;
  /** Keha drafts older than 14 days, no longer counted as ordered. */
  staleDrafts?: number;
  /** The next order after the next 7 days (the empty state). */
  next?: { supplierKey: string; name: string; kind: "supplier" | "vendor"; orderBy: string } | null;
  /** Products marked "Don't reorder". */
  notReordered?: number;
};

/**
 * Order now: the forward plan's orders due in the next 7 days, grouped by supplier — the same
 * function, orders and quantities as the Dashboard's "Order this week" (models/order-plan.server)
 * — and the open orders. `scope`: "online" or a Location.id. `selected` (?variants=) and
 * `planned` (the Season plan's quantities) add those variants; `link` (orderLink: a supplier
 * and a date range) shows that supplier's planned orders in the range instead of the next 7
 * days — resolved here, so no order is ever cut short by the URL.
 */
export async function loadReorder(
  shop: string,
  selected: string[] = [],
  scope: string = METRIC_SCOPE,
  planned: ReadonlyMap<string, number> = new Map(),
  now: Date = new Date(),
  link: { supplierKey: string | null; from: string; to: string } | null = null,
): Promise<ReorderData> {
  const basics = await shopBasics(shop);
  const [{ data: plan, suppliers }, open] = await Promise.all([computeOrderPlan(shop, now, { scope, lastYear: true }), openOrders(shop)]);
  const asked = [...new Set([...selected, ...planned.keys()])];
  const missing = asked.filter((id) => !plan.variants[id]);
  const extra = missing.length
    ? await prisma.variant.findMany({
        where: { shop, id: { in: missing }, tracked: true, isBundle: false },
        select: { id: true, productId: true, productTitle: true, variantTitle: true, sku: true, vendor: true, image: true, supplierId: true, caseQty: true, cost: true, costCurrency: true, noReorder: true },
      })
    : [];
  const known = new Set([...Object.keys(plan.variants), ...extra.map((v) => v.id)]);
  const lineIds = [...new Set([...plan.events.map((e) => e.variantId), ...extra.map((v) => v.id)])];
  const [stock, onOrder] = await Promise.all([
    scope === METRIC_SCOPE ? poolStock(shop, lineIds) : locationStock(shop, lineIds, scope),
    kehaOnOrder(shop, REORDER_HOLD_STATUSES, lineIds, { now }),
  ]);
  const groups = buildOrderNow({
    plan,
    extraVariants: extra.map((v) => ({ ...v, cost: num(v.cost) })),
    suppliers: suppliers.map(({ email, ...s }) => ({ ...s, hasEmail: !!email })),
    defaultLeadTimeDays: basics.leadTimeDays,
    stock,
    onOrder: new Map([...onOrder].map(([k, v]) => [k, v.qty])),
    selected: new Set(selected.filter((s) => known.has(s))),
    planned: new Map([...planned].filter(([id]) => known.has(id))),
    link,
  });
  const week = thisWeek(plan);
  const nextKey = week.next?.supplierKey;
  return {
    groups,
    openOrders: open,
    currency: basics.currency,
    missingSelected: asked.filter((s) => !known.has(s)).length,
    today: plan.today,
    staleDrafts: plan.staleDrafts ?? 0,
    notReordered: plan.notReordered ?? 0,
    next:
      week.next && nextKey
        ? { supplierKey: nextKey, name: plan.suppliers[nextKey]?.name ?? "", kind: plan.suppliers[nextKey]?.kind ?? "vendor", orderBy: week.next.orderBy }
        : null,
  };
}

/** A saved Season plan's lines (`?scenario=&group=`): variant → planned quantity; null when not this shop's. */
export async function scenarioPlanned(shop: string, id: string, groupKey: string | null): Promise<Map<string, number> | null> {
  const row = await prisma.scenario.findFirst({ where: { id, shop }, select: { result: true } });
  if (!row) return null;
  return scenarioQuantities(readScenarioResult(row.result), groupKey);
}

/** Marks a whole product or one variant "Don't reorder" (or back). Our database only — the store isn't changed. */
export async function setNoReorder(
  shop: string,
  target: { variantId: string } | { productId: string },
  value: boolean,
): Promise<{ ok: true; count: number } | { ok: false }> {
  const where = "variantId" in target ? { shop, id: target.variantId } : { shop, productId: target.productId };
  const r = await prisma.variant.updateMany({ where, data: { noReorder: value } });
  return r.count > 0 ? { ok: true, count: r.count } : { ok: false };
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
  const picked = group.lines.filter((l) => (quantities[l.variantId] ?? 0) > 0);
  if (!picked.length) return { ok: false, error: "empty" };
  // Lines are valued in the store currency from Shopify's cost (audit 2026-10-17): the order page,
  // PDF, CSV, email and supplier page convert to the supplier's currency when it has an exchange rate.
  const [basics, costs] = await Promise.all([
    shopBasics(shop),
    prisma.variant.findMany({ where: { shop, id: { in: picked.map((l) => l.variantId) } }, select: { id: true, cost: true, costCurrency: true } }),
  ]);
  const store = basics.currency.toUpperCase();
  const costOf = new Map(
    costs.map((c) => [c.id, (c.costCurrency || store).toUpperCase() === store ? num(c.cost) : null] as const),
  );
  const lines: PoLine[] = picked.map((l) => ({
    variantId: l.variantId,
    qty: quantities[l.variantId]!,
    unitCost: costOf.get(l.variantId) ?? null,
    productTitle: l.productTitle,
    variantTitle: l.variantTitle,
    sku: l.sku,
  }));
  const created = await insertWithNumber(shop, {
    supplierId: group.supplierId,
    supplierName: group.name || null,
    status: "draft",
    source: "keha",
    lines: lines as unknown as Prisma.InputJsonValue,
    currency: basics.currency,
    note: view.note,
  });
  return { ok: true, ...created };
}

export type OrderSupplier = {
  name: string;
  hasEmail: boolean;
  hidePrices: boolean;
  leadTimeDays: number;
  /** Ship date → arrival (freight); null = the ship date is the arrival. */
  transitDays: number | null;
  /** The currency the supplier is paid in; null = the store currency. */
  currency: string | null;
  /** 1 unit of the supplier's currency in the store currency; null = unknown. */
  exchangeRate: number | null;
  minOrder: number | null;
  minOrderTotal: number | null;
  /** In the supplier's currency. */
  minOrderValue: number | null;
  minOrderScope: string;
};

export type OrderDetail = {
  id: string;
  number: string;
  source: "keha" | "shopify";
  status: PoStatus;
  supplierId: string | null;
  supplierName: string | null;
  supplier: OrderSupplier | null;
  lines: PoLine[];
  /** The currency the lines are stored in (Keha orders: the store currency). */
  currency: string | null;
  storeCurrency: string;
  confirmToken: string;
  confirmExpiresAt: string | null;
  confirmedShipDate: string | null;
  expectedDate: string | null;
  /** Expected arrival: confirmed ship date + transit days, else the lead-time estimate (poArrival). */
  arrival: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  /** Optimistic check for edits and receipts. */
  updatedAt: string | null;
};

export async function getOrder(shop: string, id: string): Promise<OrderDetail | null> {
  const o = await prisma.purchaseOrder.findFirst({ where: { id, shop } });
  if (!o) return null;
  const [s, shopRow] = await Promise.all([
    o.supplierId
      ? prisma.supplier.findFirst({
          where: { id: o.supplierId, shop },
          select: {
            name: true,
            email: true,
            hidePrices: true,
            leadTimeDays: true,
            transitDays: true,
            currency: true,
            exchangeRate: true,
            minOrder: true,
            minOrderTotal: true,
            minOrderValue: true,
            minOrderScope: true,
          },
        })
      : null,
    prisma.shop.findUnique({ where: { domain: shop }, select: { currency: true } }),
  ]);
  const supplier: OrderSupplier | null = s
    ? {
        name: s.name,
        hasEmail: !!s.email,
        hidePrices: s.hidePrices,
        leadTimeDays: s.leadTimeDays,
        transitDays: s.transitDays ?? null,
        currency: s.currency ?? null,
        exchangeRate: num(s.exchangeRate),
        minOrder: s.minOrder ?? null,
        minOrderTotal: s.minOrderTotal ?? null,
        minOrderValue: num(s.minOrderValue),
        minOrderScope: s.minOrderScope ?? "variant",
      }
    : null;
  return {
    id: o.id,
    number: o.number,
    source: o.source === "shopify" ? "shopify" : "keha",
    status: o.status as PoStatus,
    supplierId: o.supplierId,
    supplierName: o.supplierName,
    supplier,
    lines: readPoLines(o.lines),
    currency: o.currency,
    storeCurrency: shopRow?.currency ?? o.currency ?? "USD",
    confirmToken: o.confirmToken,
    confirmExpiresAt: o.confirmExpiresAt?.toISOString() ?? null,
    confirmedShipDate: dayOf(o.confirmedShipDate),
    expectedDate: dayOf(o.expectedDate),
    arrival: dayOf(poArrival(o, supplier?.transitDays)),
    sentAt: o.sentAt?.toISOString() ?? null,
    receivedAt: o.receivedAt?.toISOString() ?? null,
    cancelledAt: o.cancelledAt?.toISOString() ?? null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt ? o.updatedAt.toISOString() : null,
  };
}

/** How this order's prices are shown (lib/purchase-order-shared, client-safe). */
export { pricingFor };

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
    // Everything still open arrived; re-opening restores the received units from before.
    data.lines = lines.map((l) => ({ ...l, received: l.qty, reopenReceived: l.received ?? 0 })) as unknown as Prisma.InputJsonValue;
  } else if (to === "cancelled") {
    data.cancelledAt = now;
  }
  const r = await prisma.purchaseOrder.updateMany({ where: { id, shop, status: o.status }, data });
  return r.count === 1 ? { ok: true } : { ok: false, error: "changed" };
}

// ── Draft edits, receiving, re-opening, the Open orders list (merchant audit 2026-10-17) ──

export type OrderEditResult = { ok: true } | { ok: false; error: "notFound" | "notAllowed" | "changed" | "invalid" | "empty" | "nothing" };

/** The order as last read must still be the one in the database (another tab, auto-receive). */
const sameVersion = (row: { updatedAt?: Date | null }, version: unknown) =>
  typeof version !== "string" || !row.updatedAt || row.updatedAt.toISOString() === version;

/**
 * Change a draft's quantities / remove lines (one quantity per line, 0 removes it). Only Keha
 * drafts: a sent order is what the supplier has, so it stays read-only (receive less, or close
 * the rest as short).
 */
export async function updateDraft(shop: string, id: string, quantities: unknown, version?: unknown): Promise<OrderEditResult> {
  const o = await prisma.purchaseOrder.findFirst({ where: { id, shop }, select: { status: true, source: true, lines: true, updatedAt: true } });
  if (!o) return { ok: false, error: "notFound" };
  if (o.source !== "keha" || o.status !== "draft") return { ok: false, error: "notAllowed" };
  if (!sameVersion(o, version)) return { ok: false, error: "changed" };
  const r = applyDraftEdit(readPoLines(o.lines), quantities);
  if (!r.ok) return r;
  const u = await prisma.purchaseOrder.updateMany({
    where: { id, shop, source: "keha", status: "draft" },
    data: { lines: r.lines as unknown as Prisma.InputJsonValue },
  });
  return u.count === 1 ? { ok: true } : { ok: false, error: "changed" };
}

/** Delete a Keha draft (nothing was sent, so nothing else knows about it). */
export async function deleteDraft(shop: string, id: string): Promise<OrderEditResult> {
  const o = await prisma.purchaseOrder.findFirst({ where: { id, shop }, select: { status: true, source: true } });
  if (!o) return { ok: false, error: "notFound" };
  if (o.source !== "keha" || o.status !== "draft") return { ok: false, error: "notAllowed" };
  const d = await prisma.purchaseOrder.deleteMany({ where: { id, shop, source: "keha", status: "draft" } });
  return d.count === 1 ? { ok: true } : { ok: false, error: "changed" };
}

/**
 * Record a delivery on a sent / confirmed Keha order: units received now per line. The order
 * stays open ("Partially received") until nothing is left, or the merchant closes the rest as
 * short. Only the remaining units count as on order.
 */
export async function receiveOrder(
  shop: string,
  id: string,
  receivedNow: unknown,
  closeShort: boolean,
  version?: unknown,
  now: Date = new Date(),
): Promise<OrderEditResult> {
  const o = await prisma.purchaseOrder.findFirst({ where: { id, shop }, select: { status: true, source: true, lines: true, updatedAt: true } });
  if (!o) return { ok: false, error: "notFound" };
  if (o.source !== "keha" || (o.status !== "sent" && o.status !== "confirmed")) return { ok: false, error: "notAllowed" };
  if (!sameVersion(o, version)) return { ok: false, error: "changed" };
  const r = applyReceipt(readPoLines(o.lines), receivedNow, closeShort);
  if (!r.ok) return r;
  const data: Prisma.PurchaseOrderUpdateManyMutationInput = { lines: r.lines as unknown as Prisma.InputJsonValue };
  if (r.close) {
    data.status = "received";
    data.receivedAt = now;
  }
  const u = await prisma.purchaseOrder.updateMany({ where: { id, shop, status: o.status }, data });
  return u.count === 1 ? { ok: true } : { ok: false, error: "changed" };
}

export type ReopenResult = { ok: true; to: PoStatus } | { ok: false; error: "notFound" | "notAllowed" | "changed" };

/**
 * Re-open a received (incl. automatically received) or cancelled Keha order within 30 days: it
 * goes back to the status it had (confirmed / sent; a cancelled draft to draft) and a received
 * order's lines get back the received units from before it closed.
 */
export async function reopenOrder(shop: string, id: string, now: Date = new Date()): Promise<ReopenResult> {
  const o = await prisma.purchaseOrder.findFirst({
    where: { id, shop },
    select: { status: true, source: true, lines: true, sentAt: true, confirmedShipDate: true, receivedAt: true, cancelledAt: true },
  });
  if (!o) return { ok: false, error: "notFound" };
  const to = reopenTarget(o, now);
  if (!to) return { ok: false, error: "notAllowed" };
  const u = await prisma.purchaseOrder.updateMany({
    where: { id, shop, status: o.status },
    data: {
      status: to,
      receivedAt: null,
      cancelledAt: null,
      lines: reopenedLines(readPoLines(o.lines), o.status) as unknown as Prisma.InputJsonValue,
    },
  });
  return u.count === 1 ? { ok: true, to } : { ok: false, error: "changed" };
}

/**
 * The Open orders tab: Keha drafts / sent / confirmed and Shopify orders not received, with
 * ship date and arrival (ship + the supplier's transit days), remaining units, age, drafts no
 * longer counted as ordered, and overdue arrivals; sorted by arrival.
 */
export async function openOrderList(shop: string, now: Date = new Date()): Promise<{ rows: OpenOrderListRow[]; today: string }> {
  const [basics, rows] = await Promise.all([
    shopBasics(shop),
    prisma.purchaseOrder.findMany({
      where: {
        shop,
        OR: [
          { source: "keha", status: { in: [...REORDER_HOLD_STATUSES] } },
          { source: "shopify", status: "sent" },
        ],
      },
      orderBy: [{ createdAt: "desc" }],
      take: 200,
    }),
  ]);
  const supplierIds = [...new Set(rows.map((r) => r.supplierId).filter((x): x is string => !!x))];
  const transit = new Map(
    (supplierIds.length
      ? await prisma.supplier.findMany({ where: { shop, id: { in: supplierIds } }, select: { id: true, transitDays: true } })
      : []
    ).map((x) => [x.id, x.transitDays ?? null]),
  );
  const today = todayIn(basics.timezone, now);
  return {
    today,
    rows: openOrderRows(
      rows.map((o) => ({
        id: o.id,
        number: o.number,
        source: o.source,
        status: o.status,
        supplierName: o.supplierName,
        lines: readPoLines(o.lines),
        currency: o.currency,
        confirmedShipDate: dayOf(o.confirmedShipDate),
        arrival: dayOf(poArrival(o, o.supplierId ? transit.get(o.supplierId) : null)),
        createdAt: o.createdAt.toISOString(),
        sentAt: o.sentAt?.toISOString() ?? null,
      })),
      { now, today, counts: poCountsAsOrdered },
    ),
  };
}
