/**
 * Nightly purchase-order jobs (spec §6.3, §6.6, J3), called once from the
 * nightly run after stock now is refreshed:
 *
 *  1. syncShopifyPurchaseOrders — reads Shopify purchase orders
 *     (inventoryPurchaseOrders, API 2026-10, paginated) and upserts them as
 *     PurchaseOrder rows with source "shopify", keyed by (shop, shopifyPoId).
 *     After a complete read, Shopify orders that no longer exist are removed.
 *  2. autoReceiveOrders — closes sent / confirmed Keha orders whose stock
 *     landed (lib/purchase-order-shared autoReceiveDecision).
 *
 * Throttling (gql retries, then AdminThrottledError), ACCESS_DENIED (a store
 * that hasn't granted read_inventory_purchase_orders yet) and any other error
 * are logged and skipped: they never break the nightly run.
 */
import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import type { AdminGraphqlClient } from "../../models/shop.server";
import { gql, type SyncDeps } from "./catalog.server";
import { newConfirmToken, poolStock } from "../../models/reorder.server";
import {
  PO_MAX_PAGES,
  PURCHASE_ORDERS_QUERY,
  PURCHASE_ORDER_LINES_QUERY,
  parsePoLine,
  parseShopifyPo,
  withMoreLines,
  type GqlPoLine,
  type GqlPurchaseOrder,
  type ParsedShopifyPo,
} from "../../lib/sync/po-shared";
import { autoReceiveDecision } from "../../lib/purchase-order-shared";
import { poArrival, readPoLines, type PoLine } from "../../lib/supplier-shared";
import { localDate, safeTimeZone } from "../../lib/sync/store-time-shared";
import { addDays } from "../../lib/engine/dates-shared";
import { ALL, dayDate } from "../../lib/sync/facts-shared";
import { poolLocationIds, poolSalesKeys } from "../../lib/compute-shared";
import { syncErrorCode } from "../../lib/sync/errors-shared";

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

export type PoSyncResult = { status: "done" | "capped" | "error"; upserted: number; removed: number };

export async function syncShopifyPurchaseOrders(
  admin: AdminGraphqlClient,
  shop: string,
  deps: SyncDeps = {},
): Promise<PoSyncResult> {
  const now = new Date((deps.now ?? Date.now)());
  const seen: string[] = [];
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
  let removed = 0;
  if (complete) {
    removed = (
      await prisma.purchaseOrder.deleteMany({ where: { shop, source: "shopify", NOT: { shopifyPoId: { in: seen } } } })
    ).count;
  }
  return { status: complete ? "done" : "capped", upserted, removed };
}

/** Closes sent / confirmed Keha orders whose stock has landed. Returns how many closed. */
export async function autoReceiveOrders(shop: string, now: Date = new Date()): Promise<number> {
  const [shopRow, orders] = await Promise.all([
    prisma.shop.findUnique({ where: { domain: shop }, select: { timezone: true } }),
    prisma.purchaseOrder.findMany({
      where: { shop, source: "keha", status: { in: ["sent", "confirmed"] } },
      select: { id: true, status: true, source: true, lines: true, sentAt: true, confirmedShipDate: true, expectedDate: true },
    }),
  ]);
  if (!orders.length) return 0;
  const tz = safeTimeZone(shopRow?.timezone);
  const today = localDate(now, tz);
  const locations = await prisma.location.findMany({ where: { shop }, select: { id: true, active: true, online: true } });
  const pool = poolLocationIds(locations);
  let closed = 0;
  for (const o of orders) {
    const arrival = poArrival(o)?.toISOString().slice(0, 10) ?? null;
    if (!arrival || arrival > today || !o.sentAt) continue;
    const lines = readPoLines(o.lines);
    const ids = [...new Set(lines.map((l) => l.variantId))];
    if (!ids.length || !pool.length) continue;
    const sentDay = localDate(o.sentAt, tz);
    const needBaseline = lines.filter((l) => l.baseOnHand === undefined).map((l) => l.variantId);
    const [stock, baseRows, sold] = await Promise.all([
      poolStock(shop, ids),
      needBaseline.length
        ? prisma.stockDaily.groupBy({
            by: ["variantId"],
            where: { shop, variantId: { in: needBaseline }, locationId: { in: pool }, day: dayDate(addDays(sentDay, -1)) },
            _sum: { endUnits: true },
          })
        : Promise.resolve([]),
      prisma.salesDaily.groupBy({
        by: ["variantId"],
        where: { shop, variantId: { in: ids }, channel: ALL, locationKey: { in: poolSalesKeys(pool) }, day: { gte: dayDate(sentDay) } },
        _sum: { sold: true },
      }),
    ]);
    const onHand = new Map<string, number>();
    for (const [k, v] of stock) if (typeof v.onHand === "number") onHand.set(k, v.onHand);
    const decision = autoReceiveDecision({
      status: o.status,
      source: o.source,
      arrival,
      today,
      lines,
      baseline: new Map(baseRows.map((r) => [r.variantId, r._sum.endUnits ?? 0])),
      onHand,
      soldSince: new Map(sold.map((r) => [r.variantId, r._sum.sold ?? 0])),
    });
    if (!decision.receive) continue;
    const r = await prisma.purchaseOrder.updateMany({
      where: { id: o.id, shop, status: o.status },
      data: {
        status: "received",
        receivedAt: now,
        lines: lines.map((l) => ({ ...l, received: decision.received[l.variantId] ?? 0 })) as unknown as Prisma.InputJsonValue,
      },
    });
    closed += r.count;
  }
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
