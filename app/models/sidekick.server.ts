/**
 * Database reads for the Sidekick tools (app/services/sidekick.server.ts) that
 * no other model already has. Database only — Sidekick data tools must answer
 * within 1 second, so nothing here calls Shopify. Each read selects only the
 * columns it needs and filters on an indexed `shop` column first.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { METRIC_SCOPE, toProductRow, type ProductRow } from "../lib/products-shared";
import { readSettings } from "../lib/settings-shared";
import { kehaOnOrder, poolStock } from "./reorder.server";
import { planView, withPlan } from "./products.server";

/** Keha orders that count as "on order" (same as Products: drafts aren't ordered yet). */
const ON_ORDER_STATUSES = ["sent", "confirmed"] as const;

export type FoundVariant = ProductRow & { productId: string };

/**
 * Tracked, non-bundle variants matching every word (in the product title, the
 * variant title or the SKU, any case): "blue hoodie" finds "Hoodie / Blue".
 * Returns at most `take` rows and the number of matches. "Suggested qty" and the
 * order-by date are the forward plan's (the same as Order now and Products);
 * a variant marked "Don't reorder" has none.
 */
export async function searchVariantStock(
  shop: string,
  words: readonly string[],
  forecast: boolean,
  take: number,
): Promise<{ rows: FoundVariant[]; total: number }> {
  if (!words.length) return { rows: [], total: 0 };
  const where: Prisma.VariantWhereInput = {
    shop,
    tracked: true,
    isBundle: false,
    AND: words.map((w) => ({
      OR: [
        { productTitle: { contains: w, mode: "insensitive" } },
        { variantTitle: { contains: w, mode: "insensitive" } },
        { sku: { contains: w, mode: "insensitive" } },
      ],
    })),
  };
  const [total, variants] = await Promise.all([
    prisma.variant.count({ where }),
    prisma.variant.findMany({
      where,
      select: { id: true, productId: true, productTitle: true, variantTitle: true, sku: true, vendor: true, image: true, noReorder: true },
      orderBy: [{ productTitle: "asc" }, { variantTitle: "asc" }, { id: "asc" }],
      take,
    }),
  ]);
  if (!variants.length) return { rows: [], total };
  const ids = variants.map((v) => v.id);
  const [metrics, stock, onOrder, view] = await Promise.all([
    prisma.variantMetric.findMany({
      where: { shop, scope: METRIC_SCOPE, variantId: { in: ids } },
      select: { variantId: true, status: true, rate: true, daysLeft: true, neverRunsOut: true, orderQty: true, orderBy: true },
    }),
    poolStock(shop, ids),
    kehaOnOrder(shop, ON_ORDER_STATUSES, ids),
    forecast ? planView(shop) : Promise.resolve(null),
  ]);
  const byId = new Map(metrics.map((m) => [m.variantId, m]));
  return {
    rows: variants.map((v) => ({
      ...withPlan(toProductRow(v, byId.get(v.id), stock.get(v.id), forecast, onOrder.get(v.id)), view, !!v.noReorder),
      productId: v.productId,
    })),
    total,
  };
}

/** Variant ids with status Dead in the online pool (VariantMetric @@index([shop, status])). */
export async function deadVariantIds(shop: string): Promise<string[]> {
  const rows = await prisma.variantMetric.findMany({
    where: { shop, scope: METRIC_SCOPE, status: "dead" },
    select: { variantId: true },
  });
  return rows.map((r) => r.variantId);
}

/** The latest graded months, newest first. */
export async function accuracyMonths(
  shop: string,
  take: number,
): Promise<{ month: string; storeErrorPct: number | null; top20ErrorPct: number | null; graded: number }[]> {
  const rows = await prisma.accuracyMonth.findMany({
    where: { shop },
    orderBy: { month: "desc" },
    take,
    select: { month: true, storeErrorPct: true, top20ErrorPct: true, graded: true },
  });
  return rows.map((r) => ({
    month: (r.month instanceof Date ? r.month.toISOString() : String(r.month)).slice(0, 10),
    storeErrorPct: r.storeErrorPct,
    top20ErrorPct: r.top20ErrorPct,
    graded: r.graded,
  }));
}

/** Currency, time zone and the dead-stock period of a store; null before the first sync created it. */
export async function shopFacts(shop: string): Promise<{ currency: string; timezone: string; deadDays: number } | null> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { currency: true, timezone: true, settings: true } });
  if (!row) return null;
  return { currency: row.currency, timezone: row.timezone, deadDays: readSettings(row.settings).deadDays };
}
