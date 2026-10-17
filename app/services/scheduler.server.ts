/**
 * Scheduler — Railway has no "ping this URL on a schedule" cron, so the service runs its own
 * timers. Started once from entry.server.tsx at boot (global-guarded against dev-server module
 * reloads).
 *
 * DB scale #2 (audit 2026-10-17): the per-shop work no longer runs inline in one serial loop.
 * The hourly ticks only QUEUE jobs (services/jobs: a Postgres queue, FOR UPDATE SKIP LOCKED, a
 * lease per shop) and INVENTORY_WORKERS worker loops (default 2) run them, on any instance:
 *   - data (spec §6.6): per installed shop, `backfill` until it has finished, then `nightly`
 *     when due (03:00 store-local, once per store-local day); each queues `compute` when its
 *     facts change. A backfill job runs 6 steps with a 30 s throttle-wait budget (review H4) and
 *     queues itself again while in progress, so large stores share the workers fairly;
 *   - alerts (spec §6.6 "alerts"): one `alerts` job per installed shop, hourly;
 *   - install (afterAuth) queues the shop's backfill instead of running it in the web request.
 * WORKER_MODE decides what this instance does: `all` (default — today's single Railway
 * service: pages, timers and workers), `web` (pages only), `worker` (timers and workers only —
 * to scale, run a second Railway service from the same image with WORKER_MODE=worker and set
 * the web one to WORKER_MODE=web, so heavy compute never shares the event loop with page loads).
 *
 * Shop-wide timers — idempotent, and each takes a "tick:<name>" lease so one instance runs it:
 *   - outbox:           every 2 min, retry-safe by design (Nova dedupes, backoff in DB)
 *   - GDPR purge:       hourly, once per shop via UninstalledShop.purgedAt
 *   - app pricing:      every 6 h, each shop's plan from the Partner API
 *   - personal-data access log: hourly, rows older than 90 days removed
 *   - Monday email (spec §11): hourly; sends when it is Monday ≥ 08:00 in the store's time zone,
 *     once per store week via OwnerEmailLog
 *   - accuracy snapshot / grade (spec §7.8): hourly
 *   - job queue upkeep: claims that kept dying are set aside (hourly, with purge)
 *   - fact partitions: hourly, queues the store-wide `maintenance` job (months ahead created,
 *     months past retention dropped — services/partitions.server)
 * A lease the database cannot give (it is down) lets the timer run anyway: each one is idempotent.
 *
 * Boot runs every hourly job once (after BOOT_DELAY_MS), so a restart never leaves a job
 * waiting up to an hour.
 *
 * The /cron/* HTTP endpoints remain (token-guarded) as manual triggers and as an
 * external-scheduler option. Set INVENTORY_DISABLE_INTERNAL_CRON=1 to turn the internal timers
 * and workers off if an external scheduler is ever preferred.
 */
import prisma from "../db.server";
import { flushOutbox, scrubDeliveredOutbox } from "../lib/nova.server";
import { purgeDueShops } from "./gdpr.server";
import { purgeOldPersonalDataLogs } from "./pii-log.server";
import { syncAllPlans } from "./app-pricing.server";
import { unauthenticated } from "../shopify.server";
import type { DataJobDeps } from "./sync/backfill.server";
import { computeAfterSync } from "./compute.server";
import { isBackfillDone, readBackfillState } from "../lib/sync/backfill-shared";
import { isNightlyDue, safeTimeZone } from "../lib/sync/store-time-shared";
import { runMondayEmailsAllShops } from "./monday.server";
import { runAccuracyAllShops } from "./accuracy.server";
import { alertsTick } from "./alerts.server";
import { GLOBAL_JOB_SHOP, tickLeaseKey, workerCount, workerMode, type JobKind, type WorkerMode } from "../lib/jobs-shared";
import { enqueueJob, jobStore } from "./jobs/queue.server";
import { INSTANCE_ID, startWorkers, workerStatus, type Workers } from "./jobs/worker.server";
import { jobHandlers } from "./jobs/handlers.server";
import { slices } from "../lib/concurrency-shared";
import { recheckTick } from "./sync/weekly-recheck.server";

const OUTBOX_EVERY_MS = 2 * 60 * 1000;
const HOURLY_EVERY_MS = 60 * 60 * 1000; // daily jobs run hourly — idempotent, so
// this only makes them land closer to their due moment, never twice.
const BOOT_DELAY_MS = 30 * 1000; // let the server finish booting first

type SchedulerGlobals = {
  __kehaInvSchedulerStarted?: boolean;
  __kehaInvSchedulerMode?: WorkerMode;
  __kehaInvWorkers?: Workers;
  __kehaInvLastOutboxTick?: number;
  __kehaInvLastHourlyTick?: number;
  __kehaInvLastDataTick?: number;
  __kehaInvDataTickRunning?: boolean;
  __kehaInvLastDataTickSummary?: string;
};
const g = globalThis as unknown as SchedulerGlobals;

/** Heartbeats for /health — proves the timers and the workers of THIS instance are running. */
export function schedulerHeartbeat(): {
  started: boolean;
  mode: WorkerMode;
  lastOutboxTickAt: string | null;
  lastHourlyTickAt: string | null;
  lastDataTickAt: string | null;
  dataTickRunning: boolean;
  lastDataTick: string | null;
  workers: number;
  jobsRunning: number;
  jobsDone: number;
  jobsFailed: number;
  lastJobAt: string | null;
  lastJob: string | null;
} {
  const w = workerStatus();
  return {
    started: !!g.__kehaInvSchedulerStarted,
    mode: g.__kehaInvSchedulerMode ?? workerMode(process.env.WORKER_MODE),
    lastOutboxTickAt: g.__kehaInvLastOutboxTick ? new Date(g.__kehaInvLastOutboxTick).toISOString() : null,
    lastHourlyTickAt: g.__kehaInvLastHourlyTick ? new Date(g.__kehaInvLastHourlyTick).toISOString() : null,
    lastDataTickAt: g.__kehaInvLastDataTick ? new Date(g.__kehaInvLastDataTick).toISOString() : null,
    dataTickRunning: !!g.__kehaInvDataTickRunning,
    lastDataTick: g.__kehaInvLastDataTickSummary ?? null,
    workers: w.workers,
    jobsRunning: w.running,
    jobsDone: w.processed - w.failed,
    jobsFailed: w.failed,
    lastJobAt: w.lastJobAt,
    lastJob: w.lastJob,
  };
}

/** Deps for the data jobs: offline Admin client per shop; inline compute for a manual run (the job handlers queue it instead). */
export const dataJobDeps: DataJobDeps = {
  getAdmin: async (shop) => (await unauthenticated.admin(shop)).admin,
  afterSync: computeAfterSync,
};

/**
 * Runs `fn` only if this instance takes the "tick:<name>" lease for `ttlMs` (one instance per
 * timer). The database not answering lets it run (fail open: every timer is idempotent).
 */
async function onceAcross(name: string, ttlMs: number, fn: () => Promise<unknown>): Promise<void> {
  let mine = true;
  try {
    mine = await jobStore().lease(tickLeaseKey(name), INSTANCE_ID, ttlMs);
  } catch {
    mine = true;
  }
  if (mine) await fn();
}

export type DataTickOptions = { now?: () => number };

/**
 * Hourly data tick: queues, for each installed shop (one with a session), its `backfill` until
 * it has finished, else its `nightly` when due. The jobs run on the workers. Returns counts
 * ("backfill", "nightly", "not_due", "skipped", "error"; "overlap" when a tick is still running).
 * Exported for tests and a manual trigger. Never throws.
 */
export async function dataTick(opts: DataTickOptions = {}): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (g.__kehaInvDataTickRunning) {
    counts.overlap = 1;
    return counts;
  }
  g.__kehaInvDataTickRunning = true;
  const now = new Date(opts.now?.() ?? Date.now());
  g.__kehaInvLastDataTick = now.getTime();
  try {
    const sessions = await prisma.session.findMany({ distinct: ["shop"], select: { shop: true } });
    const shops = sessions.map((s) => s.shop);
    const rows = new Map<string, { domain: string; backfillState: unknown; uninstalledAt: Date | null; timezone: string; lastNightlyAt: Date | null }>();
    for (const chunk of slices(shops, 5000)) {
      for (const r of await prisma.shop.findMany({
        where: { domain: { in: chunk } },
        select: { domain: true, backfillState: true, uninstalledAt: true, timezone: true, lastNightlyAt: true },
      }))
        rows.set(r.domain, r);
    }
    for (const shop of shops) {
      const row = rows.get(shop);
      let kind: JobKind | null = null;
      if (row?.uninstalledAt) counts.skipped = (counts.skipped ?? 0) + 1;
      else if (!row || !isBackfillDone(readBackfillState(row.backfillState))) kind = "backfill";
      else if (isNightlyDue(now, safeTimeZone(row.timezone), row.lastNightlyAt)) kind = "nightly";
      else counts.not_due = (counts.not_due ?? 0) + 1;
      if (!kind) continue;
      const ok = await enqueueJob(shop, kind);
      counts[ok ? kind : "error"] = (counts[ok ? kind : "error"] ?? 0) + 1;
    }
  } catch (e) {
    counts.error = (counts.error ?? 0) + 1;
    console.error("[scheduler/data]", e);
  } finally {
    g.__kehaInvDataTickRunning = false;
    g.__kehaInvLastDataTickSummary = JSON.stringify(counts);
  }
  const active = Object.entries(counts).filter(([k]) => k !== "not_due");
  if (active.length) console.log(`[scheduler/data] queued ${JSON.stringify(counts)}`);
  return counts;
}

async function outboxTick(): Promise<void> {
  g.__kehaInvLastOutboxTick = Date.now();
  await onceAcross("outbox", OUTBOX_EVERY_MS - 10_000, async () => {
    try {
      const r = await flushOutbox(100);
      if (r.processed > 0) {
        console.log(`[scheduler/outbox] sent=${r.sent} failed=${r.failed} processed=${r.processed}`);
      }
    } catch (e) {
      console.error("[scheduler/outbox]", e);
    }
  });
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
  try {
    const setAside = await jobStore().reap();
    if (setAside > 0) console.warn(`[scheduler/jobs] set aside ${setAside} job(s) whose runs kept dying`);
  } catch {
    // the queue is unavailable: the workers report it
  }
}

/** Monday email (spec §11): due-time and send-once checks live in monday.server. */
let mondayRunning = false;
async function mondayTick(): Promise<void> {
  if (mondayRunning) return;
  mondayRunning = true;
  try {
    const r = await runMondayEmailsAllShops(new Date());
    if (r.sent + r.failed > 0) console.log(`[scheduler/monday] sent=${r.sent} failed=${r.failed} skipped=${r.skipped}`);
  } catch (e) {
    console.error("[scheduler/monday]", e);
  } finally {
    mondayRunning = false;
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

/** The hourly lease: shorter than the hour, so the next tick (any instance) can take it. */
const HOURLY_LEASE_MS = HOURLY_EVERY_MS - 5 * 60 * 1000;

/**
 * The hourly jobs, in order. Boot runs them all once too. Each one is overlap-guarded (or
 * idempotent), runs on one instance (onceAcross) and never throws.
 */
export const HOURLY_JOBS: ReadonlyArray<{ name: string; run: () => Promise<unknown> }> = [
  { name: "purge", run: () => onceAcross("purge", HOURLY_LEASE_MS, purgeTick) },
  { name: "plan sync", run: () => onceAcross("plan-sync", HOURLY_LEASE_MS, planSyncTick) },
  // spec §6.6: queues backfill / nightly per shop; the workers run them
  { name: "data sync", run: () => onceAcross("data", HOURLY_LEASE_MS, () => dataTick()) },
  { name: "monday email", run: () => onceAcross("monday", HOURLY_LEASE_MS, mondayTick) },
  // spec §7.8: snapshot on the 1st, grade last month (idempotent)
  { name: "accuracy", run: () => onceAcross("accuracy", HOURLY_LEASE_MS, () => runAccuracyAllShops(new Date())) },
  // instant alerts + Flow triggers (spec §6.6 "alerts"): queues one job per shop
  { name: "alerts", run: () => onceAcross("alerts", HOURLY_LEASE_MS, () => alertsTick()) },
  // the fact tables' month partitions (DB scale): one store-wide job on the queue
  { name: "partitions", run: () => onceAcross("partitions", HOURLY_LEASE_MS, () => enqueueJob(GLOBAL_JOB_SHOP, "maintenance")) },
  // Weekly sales re-check (owner 2026-10-18): queues each shop on its own hour of the week (services/sync/weekly-recheck.server).
  { name: "weekly recheck", run: () => onceAcross("recheck", HOURLY_LEASE_MS, () => recheckTick()) },
];

export function startScheduler(): void {
  if (process.env.INVENTORY_DISABLE_INTERNAL_CRON === "1") {
    console.log("[scheduler] internal cron disabled via INVENTORY_DISABLE_INTERNAL_CRON");
    return;
  }
  if (g.__kehaInvSchedulerStarted) return; // dev-server module reloads
  const mode = workerMode(process.env.WORKER_MODE);
  g.__kehaInvSchedulerMode = mode;
  if (mode === "web") {
    console.log("[scheduler] WORKER_MODE=web: pages only — timers and jobs run on the worker service");
    return;
  }
  g.__kehaInvSchedulerStarted = true;
  const count = workerCount(process.env.INVENTORY_WORKERS);

  const hourly = () => {
    for (const job of HOURLY_JOBS) void job.run();
  };
  setTimeout(() => {
    void outboxTick();
    hourly(); // boot runs every hourly job once
    setInterval(() => void outboxTick(), OUTBOX_EVERY_MS);
    setInterval(hourly, HOURLY_EVERY_MS);
    g.__kehaInvWorkers = startWorkers(jobHandlers({ getAdmin: dataJobDeps.getAdmin }), { count });
    console.log(
      `[scheduler] started (WORKER_MODE=${mode}) — ${count} job worker(s); outbox every 2 min; hourly and at boot: ${HOURLY_JOBS.map((j) => j.name).join(", ")}`,
    );
  }, BOOT_DELAY_MS);
}
