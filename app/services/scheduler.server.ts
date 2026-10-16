/**
 * In-process scheduler — Railway has no "ping this URL on a schedule" cron, so
 * the always-on web service runs its own timers. Started once from
 * entry.server.tsx at boot (global-guarded against dev-server module reloads).
 *
 * Every job here is idempotent, so restarts / occasional double-runs are safe:
 *   - outbox:           retry-safe by design (Nova dedupes, backoff in DB)
 *   - GDPR purge:       once per shop via UninstalledShop.purgedAt
 *   - app pricing:      every 6 h, each shop's plan from the Partner API
 *   - personal-data access log: hourly, rows older than 90 days removed
 *   - data (spec §6.6): hourly per installed shop — resume the backfill until
 *     it has finished, then the nightly sync (03:00 store-local, once per
 *     store-local day), each followed by compute. Overlap-guarded: a tick that
 *     is still running makes the next one skip; a shop already busy (install
 *     kickoff) is skipped too.
 *
 * Monday email, alerts and accuracy (spec §6.6) are added by the tasks that build them.
 *
 * The /cron/* HTTP endpoints remain (token-guarded) as manual triggers and as
 * an external-scheduler option. Set INVENTORY_DISABLE_INTERNAL_CRON=1 to turn
 * the internal timers off if an external scheduler is ever preferred.
 */
import prisma from "../db.server";
import { flushOutbox, scrubDeliveredOutbox } from "../lib/nova.server";
import { purgeDueShops } from "./gdpr.server";
import { purgeOldPersonalDataLogs } from "./pii-log.server";
import { syncAllPlans } from "./app-pricing.server";
import { unauthenticated } from "../shopify.server";
import { runBackfill, withShopLock, type DataJobDeps } from "./sync/backfill.server";
import { runNightly } from "./sync/nightly.server";
import { computeAfterSync } from "./compute.server";
import { isBackfillDone, readBackfillState } from "../lib/sync/backfill-shared";

const OUTBOX_EVERY_MS = 2 * 60 * 1000;
const HOURLY_EVERY_MS = 60 * 60 * 1000; // daily jobs run hourly — idempotent, so
// this only makes them land closer to their due moment, never twice.
const BOOT_DELAY_MS = 30 * 1000; // let the server finish booting first

type SchedulerGlobals = {
  __kehaInvSchedulerStarted?: boolean;
  __kehaInvLastOutboxTick?: number;
  __kehaInvLastHourlyTick?: number;
  __kehaInvLastDataTick?: number;
  __kehaInvDataTickRunning?: boolean;
  __kehaInvLastDataTickSummary?: string;
};
const g = globalThis as unknown as SchedulerGlobals;

/** Heartbeats for /health — proves the timers are actually firing. */
export function schedulerHeartbeat(): {
  started: boolean;
  lastOutboxTickAt: string | null;
  lastHourlyTickAt: string | null;
  lastDataTickAt: string | null;
  dataTickRunning: boolean;
  lastDataTick: string | null;
} {
  return {
    started: !!g.__kehaInvSchedulerStarted,
    lastOutboxTickAt: g.__kehaInvLastOutboxTick ? new Date(g.__kehaInvLastOutboxTick).toISOString() : null,
    lastHourlyTickAt: g.__kehaInvLastHourlyTick ? new Date(g.__kehaInvLastHourlyTick).toISOString() : null,
    lastDataTickAt: g.__kehaInvLastDataTick ? new Date(g.__kehaInvLastDataTick).toISOString() : null,
    dataTickRunning: !!g.__kehaInvDataTickRunning,
    lastDataTick: g.__kehaInvLastDataTickSummary ?? null,
  };
}

/** Deps for the data jobs: offline Admin client per shop, compute after each sync. */
export const dataJobDeps: DataJobDeps = {
  getAdmin: async (shop) => (await unauthenticated.admin(shop)).admin,
  afterSync: computeAfterSync,
};

/**
 * Hourly data tick: for each installed shop (one with a session), resume the backfill
 * until it has finished, else run the nightly job when due. Returns outcome counts.
 * Exported for tests and a manual trigger.
 */
export async function dataTick(deps: DataJobDeps = dataJobDeps): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (g.__kehaInvDataTickRunning) {
    counts.overlap = 1;
    return counts;
  }
  g.__kehaInvDataTickRunning = true;
  g.__kehaInvLastDataTick = Date.now();
  try {
    const sessions = await prisma.session.findMany({ distinct: ["shop"], select: { shop: true } });
    for (const { shop } of sessions) {
      try {
        const outcome = await withShopLock(shop, async () => {
          const row = await prisma.shop.findUnique({ where: { domain: shop }, select: { backfillState: true, uninstalledAt: true } });
          if (row?.uninstalledAt) return "skipped";
          if (!row || !isBackfillDone(readBackfillState(row.backfillState))) return `backfill:${await runBackfill(shop, deps)}`;
          return `nightly:${await runNightly(shop, deps)}`;
        });
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      } catch (e) {
        counts.error = (counts.error ?? 0) + 1;
        console.error(`[scheduler/data] ${shop}`, e);
      }
    }
  } catch (e) {
    console.error("[scheduler/data]", e);
  } finally {
    g.__kehaInvDataTickRunning = false;
    g.__kehaInvLastDataTickSummary = JSON.stringify(counts);
  }
  const active = Object.entries(counts).filter(([k]) => !k.endsWith("not_due") && !k.endsWith("done"));
  if (active.length) console.log(`[scheduler/data] ${JSON.stringify(counts)}`);
  return counts;
}

async function outboxTick(): Promise<void> {
  g.__kehaInvLastOutboxTick = Date.now();
  try {
    const r = await flushOutbox(100);
    if (r.processed > 0) {
      console.log(`[scheduler/outbox] sent=${r.sent} failed=${r.failed} processed=${r.processed}`);
    }
  } catch (e) {
    console.error("[scheduler/outbox]", e);
  }
}

async function purgeTick(): Promise<void> {
  g.__kehaInvLastHourlyTick = Date.now();
  try {
    // Shared with /cron/purge-uninstalled; skips (and cancels) shops that
    // reinstalled within the 48h window.
    const purged = await purgeDueShops();
    if (purged.length > 0) console.log(`[scheduler/purge-uninstalled] purged ${purged.length} shop(s)`);
    const scrubbed = await scrubDeliveredOutbox();
    if (scrubbed > 0) console.log(`[scheduler/outbox] cleared ${scrubbed} delivered payload(s)`);
  } catch (e) {
    console.error("[scheduler/purge-uninstalled]", e);
  }
  try {
    // Personal-data access log: keep 90 days.
    const old = await purgeOldPersonalDataLogs();
    if (old > 0) console.log(`[scheduler/pii-log] removed ${old} entr(ies) older than 90 days`);
  } catch (e) {
    console.error("[scheduler/pii-log]", e);
  }
}

/** Shopify App Pricing: re-check every shop's plan (no webhooks) — every 6th hourly tick. */
let hourlyCount = 0;
async function planSyncTick(): Promise<void> {
  if (hourlyCount++ % 6 !== 0) return;
  try {
    const shops = await prisma.session.findMany({ distinct: ["shop"], select: { shop: true } });
    const r = await syncAllPlans(
      shops.map((s) => s.shop),
      async (shop) => (await unauthenticated.admin(shop)).admin,
    );
    if (r.checked > 0) {
      console.log(`[scheduler/app-pricing] checked=${r.checked} active=${r.active} none=${r.none} unknown=${r.unknown}`);
    }
  } catch (e) {
    console.error("[scheduler/app-pricing]", e);
  }
}

export function startScheduler(): void {
  if (process.env.INVENTORY_DISABLE_INTERNAL_CRON === "1") {
    console.log("[scheduler] internal cron disabled via INVENTORY_DISABLE_INTERNAL_CRON");
    return;
  }
  if (g.__kehaInvSchedulerStarted) return; // dev-server module reloads
  g.__kehaInvSchedulerStarted = true;

  setTimeout(() => {
    void outboxTick();
    void purgeTick();
    void planSyncTick();
    void dataTick();
    setInterval(() => void outboxTick(), OUTBOX_EVERY_MS);
    setInterval(() => {
      void purgeTick();
      void planSyncTick();
      void dataTick();
    }, HOURLY_EVERY_MS);
    console.log("[scheduler] started — outbox every 2 min; purge, access-log retention, plan sync and data sync hourly");
  }, BOOT_DELAY_MS);
}
