/**
 * Home data (spec §5.1). Reads ONLY the database — no Shopify calls on page
 * load (spec §15: Home < 1.5 s). Mapping lives in app/lib/dashboard-shared.ts.
 * A missing Shop row (first load before the sync created it) is "syncing".
 */
import prisma from "../db.server";
import { facts } from "../services/facts-store.server";
import { buildHome, MIN_SALES_DAYS, planReadiness, type HomeData, type HomeRaw, type PlanReadiness } from "../lib/dashboard-shared";
import type { PlanCode } from "../lib/plan-shared";
import { readReviewAsk, reviewMoment, shouldAskForReview, type ReviewMoment } from "../lib/review-ask-shared";
import { PLAN_READY_KIND, PLAN_READY_PERIOD } from "../lib/plan-ready-email-shared";
import { emailTransportConfigured } from "../services/email.server";

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
  const [money, trackedVariants, variantsWithCost, days, supplierCount, vendors, planReadyLog] = await Promise.all([
    prisma.moneyAtStake.findFirst({ where: { shop }, orderBy: { day: "desc" } }),
    prisma.variant.count({ where: tracked }),
    prisma.variant.count({ where: { ...tracked, cost: { not: null } } }),
    // GROUP BY day … LIMIT 14: we only need to know whether 14 distinct days exist.
    facts.salesDaily.groupBy({ by: ["day"], where: { shop }, orderBy: { day: "desc" }, take: MIN_SALES_DAYS }),
    // Setup guide "Suppliers": suppliers kept (Growth+) / vendors found (Free).
    prisma.supplier.count({ where: { shop } }),
    prisma.variant.groupBy({ by: ["vendor"], where: { shop, vendor: { not: null } }, orderBy: { vendor: "asc" }, take: 1000 }),
    // The sync screen promises "we'll email you" only while that email can still go out.
    emailTransportConfigured()
      ? prisma.ownerEmailLog
          .findUnique({ where: { shop_kind_periodKey: { shop, kind: PLAN_READY_KIND, periodKey: PLAN_READY_PERIOD } }, select: { status: true } })
          .catch(() => null)
      : Promise.resolve(undefined),
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
    supplierCount,
    vendorCount: vendors.filter((v) => !!v.vendor?.trim()).length,
    planReadyEmail: planReadyLog !== undefined && planReadyLog?.status !== "SENT",
  };
}

export async function getHomeData(shop: string, plan: PlanCode, now: Date = new Date()): Promise<HomeData> {
  return buildHome(await readHomeRaw(shop), plan, now);
}

/**
 * Should this Dashboard open ask for an App Store review (lib/review-ask-shared)? Not asked
 * before, installed 24 h or more, and a success moment happened: a supplier confirmed a ship
 * date, last month's store-total forecast was within target, or a clearance discount exists.
 */
export async function reviewAskDue(shop: string, now: Date = new Date()): Promise<ReviewMoment | null> {
  const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { installedAt: true, settings: true } });
  if (!row) return null;
  const asked = readReviewAsk(row.settings);
  // Cheap checks first: no success query once we asked, or within the first day.
  if (!shouldAskForReview({ installedAt: row.installedAt, now, asked, moment: "clearance" })) return null;
  const [supplierConfirmations, accuracy, clearances] = await Promise.all([
    prisma.purchaseOrder.count({ where: { shop, source: "keha", confirmedShipDate: { not: null } } }),
    prisma.accuracyMonth.findFirst({ where: { shop }, orderBy: { month: "desc" }, select: { storeErrorPct: true } }),
    prisma.clearance.count({ where: { shop } }),
  ]);
  const moment = reviewMoment({ supplierConfirmations, lastStoreErrorPct: accuracy?.storeErrorPct ?? null, clearances });
  return shouldAskForReview({ installedAt: row.installedAt, now, asked, moment }) ? moment : null;
}

/**
 * Is the order plan ready (Home's own state: syncing / not enough sales / nothing tracked)?
 * Order now, Next 13 weeks, the Monday email and Sidekick ask this before they say anything about
 * what to order. The plan code doesn't change the state, so any plan will do.
 */
export async function getPlanReadiness(shop: string, now: Date = new Date()): Promise<PlanReadiness> {
  return planReadiness(buildHome(await readHomeRaw(shop), "free", now));
}

/** getPlanReadiness for the order-plan screens: a failed read never blocks the page (fails open). */
export async function readiness(shop: string, now: Date = new Date()): Promise<PlanReadiness> {
  try {
    return await getPlanReadiness(shop, now);
  } catch {
    return { ready: true };
  }
}
