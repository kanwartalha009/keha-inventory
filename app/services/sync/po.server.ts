/**
 * Nightly purchase-order jobs (spec §6.3, §6.6, J3), called once from the
 * nightly run after stock now is refreshed:
 *
 *  1. syncShopifyPurchaseOrders — reads Shopify purchase orders
 *     (inventoryPurchaseOrders, API 2026-10, paginated) and upserts them as
 *     PurchaseOrder rows with source "shopify", keyed by (shop, shopifyPoId).
 *     After a complete read, Shopify orders that no longer exist are removed.
 *  2. autoReceiveOrders — closes sent / confirmed Keha orders whose stock
 *     landed inside the arrival window, every line (lib/purchase-order-shared
 *     autoReceiveDecision); the merchant can re-open one for 30 days.
 *
 * Throttling (gql retries, then AdminThrottledError), ACCESS_DENIED (a store
 * that hasn't granted read_inventory_purchase_orders yet) and any other error
 * are logged and skipped: they never break the nightly run.
 */
import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { facts } from "../facts-store.server";
import type { AdminGraphqlClient } from "../../models/shop.server";
import { gql, type SyncDeps } from "./catalog.server";
import { newConfirmToken, poolStock } from "../../models/reorder.server";
import {
  PO_MAX_PAGES,
  PO_TRANSFER_PAGE_SIZE,
  PURCHASE_ORDERS_QUERY,
  PURCHASE_ORDER_LINES_QUERY,
  parsePoLine,
  parseShopifyPo,
  withMoreLines,
  type GqlPoLine,
  type GqlPurchaseOrder,
  type ParsedShopifyPo,
} from "../../lib/sync/po-shared";
import { arrivalWindowStart, autoReceiveDecision, autoReceivedLines } from "../../lib/purchase-order-shared";
import { poArrival, readPoLines, type PoLine } from "../../lib/supplier-shared";
import { localDate, safeTimeZone } from "../../lib/sync/store-time-shared";
import { addDays } from "../../lib/engine/dates-shared";
import { dayDate } from "../../lib/sync/facts-shared";
import { POOL_LOCATION_SELECT, demandScope, demandWhere, poolLocationIds } from "../../lib/compute-shared";
import { syncErrorCode } from "../../lib/sync/errors-shared";
import { forgetOrderPlan } from "../../models/plan-cache.server";

type PoPage = {
  inventoryPurchaseOrders: { nodes: GqlPurchaseOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
};
type LinesPage = {
  inventoryPurchaseOrder: {
    id: string;
    lineItems: { nodes: GqlPoLine[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  } | null;
};

const MAX_LINE_PAGES = 20;
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

async function allLines(admin: AdminGraphqlClient, po: ParsedShopifyPo, deps: SyncDeps): Promise<ParsedShopifyPo> {
  let after = po.moreLines?.after ?? null;
  const extra: PoLine[] = [];
  for (let i = 0; after && i < MAX_LINE_PAGES; i++) {
    const page = await gql<LinesPage>(admin, PURCHASE_ORDER_LINES_QUERY, { id: po.shopifyPoId, after }, deps);
    const items = page.inventoryPurchaseOrder?.lineItems;
    for (const n of items?.nodes ?? []) {
      const l = parsePoLine(n, po.currency);
      if (l) extra.push(l);
    }
    after = items?.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
  }
  return extra.length ? withMoreLines(po, extra) : po;
}

async function upsertShopifyPo(shop: string, po: ParsedShopifyPo, now: Date): Promise<void> {
  const lines = po.lines as unknown as Prisma.InputJsonValue;
  const existing = await prisma.purchaseOrder.findUnique({
    where: { shop_shopifyPoId: { shop, shopifyPoId: po.shopifyPoId } },
    select: { id: true, receivedAt: true, cancelledAt: true },
  });
  const common = {
    status: po.status,
    lines,
    supplierName: po.supplierName,
    currency: po.currency,
    sentAt: po.orderedAt,
  };
  if (existing) {
    await prisma.purchaseOrder.update({
      where: { id: existing.id },
      data: {
        ...common,
        receivedAt: po.status === "received" ? (existing.receivedAt ?? now) : null,
        cancelledAt: po.status === "cancelled" ? (existing.cancelledAt ?? now) : null,
      },
    });
    return;
  }
  const create = (number: string) =>
    prisma.purchaseOrder.create({
      data: {
        ...common,
        shop,
        number,
        source: "shopify",
        shopifyPoId: po.shopifyPoId,
        // Never used: the supplier page only opens Keha orders.
        confirmToken: newConfirmToken(),
        receivedAt: po.status === "received" ? now : null,
        cancelledAt: po.status === "cancelled" ? now : null,
      },
    });
  try {
    await create(po.number);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // The name collides with another order's number (e.g. a Keha "PO-0001"): keep both.
    await create(`${po.number} (${po.shopifyPoId.replace(/^.*\//, "")})`);
  }
}

export type PoSyncResult = { status: "done" | "capped" | "error"; upserted: number; removed: number; partial?: number };

export async function syncShopifyPurchaseOrders(
  admin: AdminGraphqlClient,
  shop: string,
  deps: SyncDeps = {},
): Promise<PoSyncResult> {
  const now = new Date((deps.now ?? Date.now)());
  const seen: string[] = [];
  const partial: string[] = [];
  let upserted = 0;
  let after: string | null = null;
  let complete = false;
  try {
    for (let page = 0; page < PO_MAX_PAGES; page++) {
      const data: PoPage = await gql<PoPage>(admin, PURCHASE_ORDERS_QUERY, { after }, deps);
      const conn = data.inventoryPurchaseOrders;
      for (const node of conn?.nodes ?? []) {
        let po = parseShopifyPo(node);
        if (!po) continue;
        if (po.moreLines) po = await allLines(admin, po, deps);
        if (po.transfersCapped) partial.push(po.number);
        await upsertShopifyPo(shop, po, now);
        seen.push(po.shopifyPoId);
        upserted++;
      }
      if (!conn?.pageInfo?.hasNextPage) {
        complete = true;
        break;
      }
      after = conn.pageInfo.endCursor;
    }
  } catch (e) {
    console.warn(`[sync/po] ${shop}: Shopify purchase orders skipped (${syncErrorCode(e)}): ${e instanceof Error ? e.message : String(e)}`);
    return { status: "error", upserted, removed: 0 };
  }
  if (partial.length) {
    // More linked transfers than one read returns: kept open, never auto-marked received (lib/sync/po-shared).
    console.warn(`[sync/po] ${shop}: ${partial.length} purchase order(s) partially read (over ${PO_TRANSFER_PAGE_SIZE} transfers), kept open: ${partial.slice(0, 5).join(", ")}`);
  }
  let removed = 0;
  if (complete) {
    removed = (
      await prisma.purchaseOrder.deleteMany({ where: { shop, source: "shopify", NOT: { shopifyPoId: { in: seen } } } })
    ).count;
  }
  return { status: complete ? "done" : "capped", upserted, removed, ...(partial.length ? { partial: partial.length } : {}) };
}

/**
 * Closes sent / confirmed Keha orders whose stock has landed (lib/purchase-order-shared
 * autoReceiveDecision): measured from the day the arrival window opened (expected arrival − 7
 * days, never before the confirmed ship date; arrival = ship date + the supplier's transit days), every open
 * line ≥ 90 %, one delivery never credited to two orders (oldest window first). The order is
 * marked as received automatically (lines' `autoReceived`) so the merchant can re-open it.
 * Returns how many closed.
 */
export async function autoReceiveOrders(shop: string, now: Date = new Date()): Promise<number> {
  const [shopRow, orders] = await Promise.all([
    prisma.shop.findUnique({ where: { domain: shop }, select: { timezone: true } }),
    prisma.purchaseOrder.findMany({
      where: { shop, source: "keha", status: { in: ["sent", "confirmed"] } },
      select: { id: true, status: true, source: true, supplierId: true, lines: true, sentAt: true, confirmedShipDate: true, expectedDate: true },
    }),
  ]);
  if (!orders.length) return 0;
  const tz = safeTimeZone(shopRow?.timezone);
  const today = localDate(now, tz);
  const supplierIds = [...new Set(orders.map((o) => o.supplierId).filter((x): x is string => !!x))];
  const transit = new Map(
    (supplierIds.length
      ? await prisma.supplier.findMany({ where: { shop, id: { in: supplierIds } }, select: { id: true, transitDays: true } })
      : []
    ).map((s) => [s.id, s.transitDays ?? null]),
  );
  const due = orders
    .map((o) => {
      const sentDay = o.sentAt ? localDate(o.sentAt, tz) : null;
      const arrival = poArrival(o, o.supplierId ? transit.get(o.supplierId) : null)?.toISOString().slice(0, 10) ?? null;
      const windowStart = arrivalWindowStart({ confirmedShipDate: o.confirmedShipDate?.toISOString().slice(0, 10) ?? null, arrival, sentDay });
      return { o, sentDay, windowStart };
    })
    .filter((x): x is { o: (typeof orders)[number]; sentDay: string; windowStart: string } => !!x.sentDay && !!x.windowStart && x.windowStart <= today)
    .sort((a, b) => (a.windowStart < b.windowStart ? -1 : a.windowStart > b.windowStart ? 1 : 0));
  if (!due.length) return 0;
  const locations = await prisma.location.findMany({ where: { shop }, select: POOL_LOCATION_SELECT });
  const pool = poolLocationIds(locations);
  if (!pool.length) return 0;
  // Stock rise already credited to an earlier order in this run, per variant.
  const used = new Map<string, number>();
  let closed = 0;
  for (const { o, sentDay, windowStart } of due) {
    const lines = readPoLines(o.lines);
    const ids = [...new Set(lines.map((l) => l.variantId))];
    if (!ids.length) continue;
    const fromSend = windowStart <= sentDay;
    const from = fromSend ? sentDay : windowStart;
    const needBaseline = fromSend ? lines.filter((l) => l.baseOnHand === undefined).map((l) => l.variantId) : ids;
    const [stock, baseRows, sold] = await Promise.all([
      poolStock(shop, ids),
      needBaseline.length
        ? facts.stockDaily.groupBy({
            by: ["variantId"],
            where: { shop, variantId: { in: needBaseline }, locationId: { in: pool }, day: dayDate(addDays(from, -1)) },
            _sum: { endUnits: true },
          })
        : Promise.resolve([]),
      facts.salesDaily.groupBy({
        by: ["variantId"],
        // Units that left the pool's stock: the SalesDaily view compute reads (demandWhere; never both
        // views), every channel — a channel left out of the forecast still takes stock.
        where: { shop, variantId: { in: ids }, ...demandWhere(demandScope(locations)), day: { gte: dayDate(from) } },
        _sum: { sold: true, returned: true },
      }),
    ]);
    const onHand = new Map<string, number>();
    for (const [k, v] of stock) if (typeof v.onHand === "number") onHand.set(k, v.onHand);
    const decision = autoReceiveDecision({
      status: o.status,
      source: o.source,
      windowStart,
      sentDay,
      today,
      lines,
      baseline: new Map(baseRows.map((r) => [r.variantId, r._sum.endUnits ?? 0])),
      onHand,
      soldSince: new Map(sold.map((r) => [r.variantId, r._sum.sold ?? 0])),
      // Restocked returns raise on-hand too: not a delivery (merchant audit 2026-10-18).
      returnedSince: new Map(sold.map((r) => [r.variantId, r._sum.returned ?? 0])),
      used,
    });
    if (!decision.receive) continue;
    const r = await prisma.purchaseOrder.updateMany({
      where: { id: o.id, shop, status: o.status },
      data: {
        status: "received",
        receivedAt: now,
        lines: autoReceivedLines(lines, decision.received) as unknown as Prisma.InputJsonValue,
      },
    });
    if (r.count === 1) for (const [v, n] of Object.entries(decision.received)) used.set(v, (used.get(v) ?? 0) + n);
    closed += r.count;
  }
  if (closed) forgetOrderPlan(shop);
  return closed;
}

/** The nightly hook: Shopify purchase orders, then auto-receive. Never throws. */
export async function runPurchaseOrderJobs(admin: AdminGraphqlClient, shop: string, deps: SyncDeps = {}): Promise<void> {
  try {
    const r = await syncShopifyPurchaseOrders(admin, shop, deps);
    if (r.upserted || r.removed) console.log(`[sync/po] ${shop}: Shopify purchase orders ${r.status}, ${r.upserted} read, ${r.removed} removed`);
  } catch (e) {
    console.error(`[sync/po] ${shop}: Shopify purchase orders failed`, e);
  }
  try {
    const closed = await autoReceiveOrders(shop, new Date((deps.now ?? Date.now)()));
    if (closed) console.log(`[sync/po] ${shop}: ${closed} order(s) received automatically`);
  } catch (e) {
    console.error(`[sync/po] ${shop}: auto-receive failed`, e);
  }
}
