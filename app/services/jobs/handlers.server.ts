/**
 * What each job kind does (DB scale #2). One run per job, per shop:
 *  - backfill: up to STEPS_PER_TICK steps with a THROTTLE_BUDGET_MS throttle-wait budget (as one
 *    shop's share of the old hourly tick, review H4); still in progress → queued again at once
 *    (behind every other due job, so large stores share the workers), throttled → in a minute;
 *  - nightly: the nightly sync (runNightly checks it is due), throttled → in five minutes;
 *  - compute: the engine (the sync jobs queue it instead of running it inline), then the one
 *    "your order plan is ready" email when the first read just finished (services/plan-ready);
 *  - alerts: instant alerts + Flow triggers for the shop;
 *  - maintenance (shop "*", queued hourly): the fact tables' month partitions — the months ahead
 *    created, the months past retention dropped (services/partitions.server).
 * The return value is a short outcome for /health ("kind:outcome"), never shop data.
 */
import prisma from "../../db.server";
import { runBackfill, type DataJobDeps } from "../sync/backfill.server";
import { runNightly } from "../sync/nightly.server";
import { computeAfterSync } from "../compute.server";
import { runAlertsForShop, type AlertsShopRow } from "../alerts.server";
import { STEPS_PER_TICK, THROTTLE_BUDGET_MS, createSleepBudget } from "../../lib/sync/budget-shared";
import { NIGHTLY_THROTTLED_RETRY_MS, THROTTLED_RETRY_MS } from "../../lib/jobs-shared";
import { maybeSendPlanReadyEmail } from "../plan-ready.server";
import { enqueueJob } from "./queue.server";
import { maintainPartitions } from "../partitions.server";
import type { JobHandlers } from "./worker.server";

export type HandlerDeps = Omit<DataJobDeps, "afterSync" | "maxSteps" | "throttleSleep"> & {
  /** Real sleep for throttle waits (tests inject a fake). */
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function jobHandlers(base: HandlerDeps): JobHandlers {
  const budgeted = (): DataJobDeps => ({
    ...base,
    throttleSleep: createSleepBudget(base.sleep ?? realSleep, THROTTLE_BUDGET_MS).sleep,
    maxSteps: STEPS_PER_TICK,
    // Compute is its own job: queued (deduplicated), it runs right after this one.
    afterSync: async (shop) => void (await enqueueJob(shop, "compute")),
  });
  return {
    backfill: async (job) => {
      const out = await runBackfill(job.shop, budgeted());
      if (out === "progress") await enqueueJob(job.shop, "backfill");
      else if (out === "throttled") await enqueueJob(job.shop, "backfill", THROTTLED_RETRY_MS);
      return out;
    },
    nightly: async (job) => {
      const out = await runNightly(job.shop, budgeted());
      if (out === "throttled") await enqueueJob(job.shop, "nightly", NIGHTLY_THROTTLED_RETRY_MS);
      return out;
    },
    compute: async (job) => {
      await computeAfterSync(job.shop);
      // Once per store, never throws: sent only when this compute made the first full plan.
      const email = await maybeSendPlanReadyEmail(job.shop);
      return email === "sent" ? "done:plan_ready_email" : "done";
    },
    alerts: async (job) => {
      const row = (await prisma.shop.findUnique({ where: { domain: job.shop } })) as AlertsShopRow | null;
      if (!row) return "skipped";
      const r = await runAlertsForShop(row, new Date());
      return `${r.instant}/${r.flow}`;
    },
    maintenance: async () => {
      const r = await maintainPartitions(new Date().toISOString().slice(0, 10));
      if (r.created || r.dropped.length) console.log(`[jobs/maintenance] partitions: ${r.created} created, dropped ${r.dropped.join(", ") || "none"} (${r.ms} ms)`);
      return `${r.created}+${r.dropped.length}-`;
    },
  };
}
