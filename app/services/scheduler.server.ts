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
 *
 * The data jobs (backfill, nightly sync, compute, Monday email, alerts,
 * accuracy — spec §6.6) are added by the tasks that build them.
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

const OUTBOX_EVERY_MS = 2 * 60 * 1000;
const HOURLY_EVERY_MS = 60 * 60 * 1000; // daily jobs run hourly — idempotent, so
// this only makes them land closer to their due moment, never twice.
const BOOT_DELAY_MS = 30 * 1000; // let the server finish booting first

type SchedulerGlobals = {
  __kehaInvSchedulerStarted?: boolean;
  __kehaInvLastOutboxTick?: number;
  __kehaInvLastHourlyTick?: number;
};
const g = globalThis as unknown as SchedulerGlobals;

/** Heartbeats for /health — proves the timers are actually firing. */
export function schedulerHeartbeat(): {
  started: boolean;
  lastOutboxTickAt: string | null;
  lastHourlyTickAt: string | null;
} {
  return {
    started: !!g.__kehaInvSchedulerStarted,
    lastOutboxTickAt: g.__kehaInvLastOutboxTick ? new Date(g.__kehaInvLastOutboxTick).toISOString() : null,
    lastHourlyTickAt: g.__kehaInvLastHourlyTick ? new Date(g.__kehaInvLastHourlyTick).toISOString() : null,
  };
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
    setInterval(() => void outboxTick(), OUTBOX_EVERY_MS);
    setInterval(() => {
      void purgeTick();
      void planSyncTick();
    }, HOURLY_EVERY_MS);
    console.log("[scheduler] started — outbox every 2 min; purge, access-log retention and plan sync hourly");
  }, BOOT_DELAY_MS);
}
