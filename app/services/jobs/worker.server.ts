/**
 * Job workers (DB scale #2): `count` loops per instance, each claiming one job at a time from the
 * queue (lib/jobs-shared, queue.server), running its handler while it extends the job's and the
 * shop's lease every LEASE_MS / 3, then completing it (or recording the failure for a retry).
 * Idle loops wait POLL_MS, or less when this process enqueues something (onEnqueue). Queue errors
 * (the database is down) back off and never stop the loop. Handlers never see another job of the
 * same shop running anywhere (the shop lease), and in this process withShopLock guards it too.
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { LEASE_MS, POLL_MS, retryDelayMs, type JobKind } from "../../lib/jobs-shared";
import { jobStore, onEnqueue, type ClaimedJob, type JobStore } from "./queue.server";
import { withShopLock } from "../sync/backfill.server";

export type JobHandler = (job: ClaimedJob) => Promise<string | void>;
export type JobHandlers = Record<JobKind, JobHandler>;

/** This process, for lease owners: host:pid:random. */
export const INSTANCE_ID = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;

export type WorkerStatus = {
  workers: number;
  running: number;
  processed: number;
  failed: number;
  lastJobAt: string | null;
  /** "kind:outcome" of the last job finished here (no shop, no error text). */
  lastJob: string | null;
};

const status: WorkerStatus = { workers: 0, running: 0, processed: 0, failed: 0, lastJobAt: null, lastJob: null };
export function workerStatus(): WorkerStatus {
  return { ...status };
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Claims and runs at most one job. "idle" when nothing was due. Never throws for a handler error
 * (recorded with a retry); throws only when the queue itself fails (the caller backs off).
 */
export async function runOneJob(
  handlers: JobHandlers,
  owner: string,
  opts: { store?: JobStore; leaseMs?: number; now?: () => number } = {},
): Promise<"idle" | "done" | "failed" | "busy"> {
  const store = opts.store ?? jobStore();
  const leaseMs = opts.leaseMs ?? LEASE_MS;
  const job = await store.claim(owner, leaseMs);
  if (!job) return "idle";
  status.running++;
  const beat = setInterval(() => {
    store.extend(job, leaseMs).then(
      (held) => held || console.warn(`[jobs] ${job.kind} ${job.shop}: lease lost while running`),
      (e) => console.error(`[jobs] ${job.kind} ${job.shop}: lease extend failed`, e),
    );
  }, Math.max(1000, Math.floor(leaseMs / 3)));
  beat.unref?.();
  let outcome: "done" | "failed" | "busy" = "done";
  let detail: string | void = undefined;
  try {
    const r = await withShopLock(job.shop, async () => (await handlers[job.kind](job)) ?? undefined);
    if (r === "busy") {
      outcome = "busy";
      await store.enqueue(job.shop, job.kind, 30_000).catch(() => {});
    } else detail = r;
    await store.complete(job);
  } catch (e) {
    outcome = "failed";
    status.failed++;
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[jobs] ${job.kind} ${job.shop} failed (attempt ${job.attempts})`, e);
    await store.fail(job, msg, retryDelayMs(job.attempts)).catch((err) => console.error(`[jobs] ${job.kind} ${job.shop}: recording the failure failed`, err));
  } finally {
    clearInterval(beat);
    status.running--;
    status.processed++;
    status.lastJobAt = new Date(opts.now?.() ?? Date.now()).toISOString();
    status.lastJob = `${job.kind}:${outcome === "done" ? (detail ?? "done") : outcome}`;
  }
  return outcome;
}

export type Workers = { stop: () => Promise<void> };

/** Starts `count` worker loops in this process. */
export function startWorkers(
  handlers: JobHandlers,
  opts: { count: number; store?: () => JobStore; pollMs?: number; sleep?: (ms: number) => Promise<void> },
): Workers {
  const sleep = opts.sleep ?? realSleep;
  const pollMs = opts.pollMs ?? POLL_MS;
  let stopping = false;
  const wakes = new Set<() => void>();
  const unsubscribe = onEnqueue(() => {
    for (const w of wakes) w();
  });
  // Waits pollMs, or until something is enqueued in this process.
  const idle = (ms: number) =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        wakes.delete(finish);
        resolve();
      };
      wakes.add(finish);
      void sleep(ms).then(finish);
    });
  status.workers += opts.count;
  const loops = Array.from({ length: opts.count }, async (_, slot) => {
    const owner = `${INSTANCE_ID}:${slot}`;
    let backoff = 0;
    let loggedAt = 0;
    while (!stopping) {
      try {
        const r = await runOneJob(handlers, owner, { store: opts.store?.() });
        backoff = 0;
        if (r === "idle") await idle(pollMs);
      } catch (e) {
        // The queue itself failed (database down, …): back off (up to a minute), keep the loop,
        // log the first failure and then every 10 minutes.
        backoff = Math.min(60_000, backoff ? backoff * 2 : pollMs);
        const t = Date.now();
        if (slot === 0 && t - loggedAt >= 10 * 60_000) {
          loggedAt = t;
          console.error("[jobs] queue unavailable, retrying", e);
        }
        await idle(backoff);
      }
    }
  });
  return {
    stop: async () => {
      stopping = true;
      for (const w of wakes) w();
      unsubscribe();
      await Promise.all(loops);
      status.workers -= opts.count;
    },
  };
}
