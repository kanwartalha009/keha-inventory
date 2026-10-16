/**
 * Home data (spec §5.1). Reads ONLY the database — no Shopify calls on page
 * load (spec §15: Home < 1.5 s). Mapping lives in app/lib/dashboard-shared.ts.
 * A missing Shop row (first load before the sync created it) is "syncing".
 */
import prisma from "../db.server";
import { buildHome, MIN_SALES_DAYS, type HomeData, type HomeRaw } from "../lib/dashboard-shared";
import type { PlanCode } from "../lib/plan-shared";

type DecimalLike = { toNumber(): number } | number | string | null;

export function decimalToNumber(v: DecimalLike | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : v.toNumber();
  return Number.isFinite(n) ? n : null;
}

export async function readHomeRaw(shop: string): Promise<HomeRaw> {
  const row = await prisma.shop.findUnique({
    where: { domain: shop },
    select: { domain: true, currency: true, timezone: true, settings: true, backfillState: true, lastNightlyAt: true },
  });
  if (!row) return { shop: null, money: null, trackedVariants: 0, variantsWithCost: 0, salesDays: 0 };

  const tracked = { shop, tracked: true, isBundle: false } as const;
  const [money, trackedVariants, variantsWithCost, days] = await Promise.all([
    prisma.moneyAtStake.findFirst({ where: { shop }, orderBy: { day: "desc" } }),
    prisma.variant.count({ where: tracked }),
    prisma.variant.count({ where: { ...tracked, cost: { not: null } } }),
    // GROUP BY day … LIMIT 14: we only need to know whether 14 distinct days exist.
    prisma.salesDaily.groupBy({ by: ["day"], where: { shop }, orderBy: { day: "desc" }, take: MIN_SALES_DAYS }),
  ]);

  return {
    shop: row,
    money: money
      ? {
          day: money.day,
          atRisk: decimalToNumber(money.atRisk),
          lost90: decimalToNumber(money.lost90),
          cashStuck: decimalToNumber(money.cashStuck),
          soldOutTraffic: decimalToNumber(money.soldOutTraffic),
          basis: money.basis,
        }
      : null,
    trackedVariants,
    variantsWithCost,
    salesDays: days.length,
  };
}

export async function getHomeData(shop: string, plan: PlanCode, now: Date = new Date()): Promise<HomeData> {
  return buildHome(await readHomeRaw(shop), plan, now);
}
