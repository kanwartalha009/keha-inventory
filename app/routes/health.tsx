/**
 * GET /health — public liveness/health probe (promised in GO-LIVE-AND-TEST-GUIDE
 * §2/§8 but missing until 2026-09-01). Reports:
 *   - db:        can we run a trivial query
 *   - scheduler: has the in-process scheduler started, and when did the outbox
 *                timer last fire (should be < ~4 min ago once booted)
 *   - outbox:    PENDING / DEAD row counts (delivery backlog to the Nova backend)
 *   - pricing:   are plan checks configured, last success / error code (2026-10-13)
 *   - config:    booleans for settings the privacy policy relies on (2026-09-28):
 *                secrets encrypted at rest, shopper email sending, legal contact
 *   - sync:      max lastNightlyAt and mean backfill % over installed shops, and the
 *                most recent dataset error as a short CODE only — never raw error text,
 *                which can carry store data (spec §17, task 1.2b, review M)
 *   - shopifyqlBudget: cost / remaining of the last ShopifyQL response (this process)
 *   - compute:   last VariantMetric.computedAt and how many shops got money cards
 *                (a MoneyAtStake row) in the last 36 h
 *
 * No auth by design (uptime monitors need it); exposes only booleans, counts,
 * short codes and timestamps — no shop data, no secrets. The sync / compute
 * aggregates scan every shop, so they are cached for 60 s.
 */
import prisma from "../db.server";
import { schedulerHeartbeat } from "../services/scheduler.server";
import { pricingStatus } from "../services/app-pricing.server";
import { shopifyqlBudget } from "../services/sync/shopifyql.server";
import { backfillPercent, isDegraded, latestError, readBackfillState } from "../lib/sync/backfill-shared";
import { knownCode, type SyncErrorCode } from "../lib/sync/errors-shared";

const outbox = prisma.novaOutbox;

const COMPUTED_WITHIN_MS = 36 * 60 * 60 * 1000;
export const AGGREGATE_CACHE_MS = 60 * 1000;

type SyncHealth = {
  lastNightlyAt: string | null;
  backfillPct: number | null;
  /** Short code of the most recent dataset error (errors-shared), never the message. */
  lastErrorCode: SyncErrorCode | null;
  lastErrorAt: string | null;
  /** Installed shops with a dataset that skipped a month after repeated failures. */
  degradedShops: number | null;
};

/** Data freshness over installed shops. Never throws (null fields on a DB error). */
async function syncHealth(): Promise<SyncHealth> {
  try {
    const shops = await prisma.shop.findMany({
      where: { uninstalledAt: null },
      select: { lastNightlyAt: true, backfillState: true },
    });
    let lastNightly: Date | null = null;
    let pctSum = 0;
    let err: { message: string; code: string | null; at: string | null } | null = null;
    let degraded = 0;
    for (const s of shops) {
      if (s.lastNightlyAt && (!lastNightly || s.lastNightlyAt > lastNightly)) lastNightly = s.lastNightlyAt;
      const state = readBackfillState(s.backfillState);
      pctSum += backfillPercent(state);
      if (isDegraded(state)) degraded++;
      const e = latestError(state);
      if (e && (!err || (e.at !== null && (err.at === null || e.at > err.at)))) err = e;
    }
    return {
      lastNightlyAt: lastNightly ? lastNightly.toISOString() : null,
      backfillPct: shops.length ? Math.round(pctSum / shops.length) : null,
      // Errors stored before codes existed have no code: "unknown", never the text.
      lastErrorCode: err ? (knownCode(err.code) ?? "unknown") : null,
      lastErrorAt: err?.at ?? null,
      degradedShops: degraded,
    };
  } catch {
    return { lastNightlyAt: null, backfillPct: null, lastErrorCode: null, lastErrorAt: null, degradedShops: null };
  }
}

/** Last engine run and the shops with money cards in the last 36 h. Never throws. */
async function computeHealth(now: Date): Promise<{ lastAt: string | null; shopsComputed: number | null }> {
  try {
    const agg = await prisma.variantMetric.aggregate({ _max: { computedAt: true } });
    // MoneyAtStake.day is the store-local calendar day; compare by date.
    const since = new Date(now.getTime() - COMPUTED_WITHIN_MS);
    const sinceDay = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
    const shops = await prisma.moneyAtStake.findMany({
      where: { day: { gte: sinceDay } },
      distinct: ["shop"],
      select: { shop: true },
    });
    return { lastAt: agg._max.computedAt ? agg._max.computedAt.toISOString() : null, shopsComputed: shops.length };
  } catch {
    return { lastAt: null, shopsComputed: null };
  }
}

type Aggregate = { sync: SyncHealth; compute: { lastAt: string | null; shopsComputed: number | null } };
let cache: { at: number; value: Aggregate } | null = null;

/** Sync + compute aggregates, cached for AGGREGATE_CACHE_MS. */
async function aggregate(nowMs: number): Promise<Aggregate> {
  if (cache && nowMs - cache.at < AGGREGATE_CACHE_MS) return cache.value;
  const [sync, compute] = await Promise.all([syncHealth(), computeHealth(new Date(nowMs))]);
  cache = { at: nowMs, value: { sync, compute } };
  return cache.value;
}

/** Test helper: drops the cached aggregate. */
export function resetHealthCache(): void {
  cache = null;
}

export const loader = async () => {
  const heartbeat = schedulerHeartbeat();

  let db = false;
  let pending = 0;
  let dead = 0;
  try {
    pending = await outbox.count({ where: { status: "PENDING" } });
    dead = await outbox.count({ where: { status: "DEAD" } });
    db = true;
  } catch {
    db = false;
  }

  // Degraded when the DB is down, or the scheduler stopped ticking (>10 min
  // since the last 2-minute outbox tick, once it has ticked at least once).
  const lastTick = heartbeat.lastOutboxTickAt
    ? Date.parse(heartbeat.lastOutboxTickAt)
    : null;
  const schedulerStale =
    heartbeat.started && lastTick !== null && Date.now() - lastTick > 10 * 60 * 1000;
  const ok = db && !schedulerStale;
  const { sync, compute } = await aggregate(Date.now());
  const budget = shopifyqlBudget();

  return Response.json(
    {
      status: ok ? "ok" : "degraded",
      db: db ? "ok" : "error",
      scheduler: heartbeat,
      outbox: { pending, dead },
      config: {
        secretsEncrypted: /^[0-9a-f]{64}$/i.test(process.env.APP_ENCRYPTION_KEY ?? ""),
        emailSending: Boolean(process.env.INVENTORY_EMAIL_API_KEY && process.env.INVENTORY_EMAIL_FROM),
        legalContact: Boolean(process.env.INVENTORY_SUPPORT_EMAIL),
        database: (process.env.DATABASE_URL ?? "").startsWith("postgres") ? "postgresql" : "other",
      },
      // Shopify App Pricing plan checks (Partner API): configured + last result.
      pricing: pricingStatus(),
      sync,
      shopifyqlBudget: { lastCost: budget.lastCost, lastRemaining: budget.lastRemaining, lastAt: budget.lastAt },
      compute,
      time: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
};
