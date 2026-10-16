/**
 * Transfer plan and the transfers Keha created (spec J7, Pro `transfers`). Database only;
 * the rules are in lib/transfers-shared, the Shopify calls in services/transfers.server.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { POOL_LOCATION_SELECT, SCOPE_ONLINE, countsForOnline } from "../lib/compute-shared";
import { planningLocations } from "../lib/locations-shared";
import {
  NEED_STATUSES,
  PENDING_TRANSFER_DAYS,
  buildTransferPlan,
  pendingTransferUnits,
  readTransferLines,
  type PlanMetric,
  type PlanVariant,
  type RecentTransfer,
  type StockAt,
  type StoredTransferLine,
  type TransferGroup,
} from "../lib/transfers-shared";

export type TransfersData = {
  groups: TransferGroup[];
  recent: RecentTransfer[];
  /** At least one active warehouse / store is set up (Settings → Locations). */
  hasWarehouse: boolean;
  hasStore: boolean;
};

const RECENT = 10;

export async function loadTransfers(shop: string, now: Date = new Date()): Promise<TransfersData> {
  const rows = await prisma.location.findMany({ where: { shop }, select: { ...POOL_LOCATION_SELECT, name: true, role: true } });
  const planning = planningLocations(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const warehouses = planning
    .filter((l) => l.role === "warehouse")
    .map((l) => ({ id: l.id, name: l.name, inPool: countsForOnline(byId.get(l.id)!) }));
  const stores = planning.filter((l) => l.role === "store").map((l) => ({ id: l.id, name: l.name }));
  const recent = await recentTransfers(shop, new Map(rows.map((r) => [r.id, r.name])));
  const base = { recent, hasWarehouse: warehouses.length > 0, hasStore: stores.length > 0 };
  if (!warehouses.length || !stores.length) return { groups: [], ...base };

  // Store lines that may need stock, then everything else only for those variants.
  const storeMetrics = await prisma.variantMetric.findMany({
    where: { shop, scope: { in: stores.map((s) => s.id) }, status: { in: [...NEED_STATUSES] } },
    select: { variantId: true, scope: true, status: true, rate: true, sigma: true, daysLeft: true, inputs: true },
  });
  const ids = [...new Set(storeMetrics.map((m) => m.variantId))];
  if (!ids.length) return { groups: [], ...base };
  const locationIds = [...warehouses.map((w) => w.id), ...stores.map((s) => s.id)];
  const [otherMetrics, stockRows, variants, pendingRows] = await Promise.all([
    prisma.variantMetric.findMany({
      where: { shop, scope: { in: [SCOPE_ONLINE, ...warehouses.map((w) => w.id)] }, variantId: { in: ids } },
      select: { variantId: true, scope: true, status: true, rate: true, sigma: true, daysLeft: true, inputs: true },
    }),
    prisma.stockNow.findMany({
      where: { shop, variantId: { in: ids }, locationId: { in: locationIds } },
      select: { variantId: true, locationId: true, onHand: true, available: true, incoming: true },
    }),
    prisma.variant.findMany({
      where: { shop, id: { in: ids }, tracked: true, isBundle: false },
      select: { id: true, productTitle: true, variantTitle: true, sku: true, image: true },
    }),
    // Keha transfers that may not have shipped yet (transfers-shared header): pending.
    prisma.transfer.findMany({
      where: { shop, createdAt: { gte: new Date(now.getTime() - PENDING_TRANSFER_DAYS * 86_400_000) } },
      select: { originLocationId: true, destinationLocationId: true, lines: true },
    }),
  ]);
  const metrics = new Map<string, Map<string, PlanMetric & { daysLeft: number | null }>>();
  for (const m of [...storeMetrics, ...otherMetrics]) {
    (metrics.get(m.scope) ?? metrics.set(m.scope, new Map()).get(m.scope)!).set(m.variantId, m);
  }
  const stock = new Map<string, Map<string, StockAt>>();
  for (const s of stockRows) {
    (stock.get(s.locationId) ?? stock.set(s.locationId, new Map()).get(s.locationId)!).set(s.variantId, {
      onHand: s.onHand,
      available: s.available,
      incoming: s.incoming,
    });
  }
  const groups = buildTransferPlan({
    warehouses,
    stores,
    variants: new Map<string, PlanVariant>(variants.map((v) => [v.id, v])),
    metrics,
    stock,
    pending: pendingTransferUnits(pendingRows),
  });
  return { groups, ...base };
}

async function recentTransfers(shop: string, names: Map<string, string>): Promise<RecentTransfer[]> {
  const rows = await prisma.transfer.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: RECENT });
  return rows.map((r) => ({
    id: r.id,
    shopifyTransferId: r.shopifyTransferId,
    originName: names.get(r.originLocationId) ?? "—",
    destinationName: names.get(r.destinationLocationId) ?? "—",
    units: readTransferLines(r.lines).reduce((a, l) => a + l.quantity, 0),
    createdAt: r.createdAt.toISOString(),
  }));
}

/** A Transfer this shop already created with this idempotency key. */
export async function transferByKey(shop: string, idempotencyKey: string) {
  const row = await prisma.transfer.findUnique({ where: { idempotencyKey } });
  return row && row.shop === shop ? row : null;
}

export async function recordTransfer(
  shop: string,
  data: { shopifyTransferId: string; originLocationId: string; destinationLocationId: string; lines: StoredTransferLine[]; idempotencyKey: string },
) {
  return prisma.transfer.create({
    data: { shop, ...data, lines: data.lines as unknown as Prisma.InputJsonValue },
  });
}

/** Store-local day and admin language for a shop (the key's day, the note's language). */
export async function shopDayContext(shop: string): Promise<{ timezone: string | null; locale: string | null }> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { timezone: true, locale: true } });
  return { timezone: row?.timezone ?? null, locale: row?.locale ?? null };
}
