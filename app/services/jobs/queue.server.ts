/**
 * The job queue's store (DB scale #2; model and SQL in lib/jobs-shared). `pgJobStore` runs the
 * shared SQL through any "run one statement" function — Prisma's $queryRawUnsafe in the app, a
 * psql session in tests/jobs-pg.test.ts — so the code tested against Postgres is the code that
 * runs. `jobStore()` is the app's store; tests swap it with setJobStore.
 */
import prisma from "../../db.server";
import {
  LEASE_MS,
  MAX_ATTEMPTS,
  SQL_CLAIM,
  SQL_COMPLETE,
  SQL_ENQUEUE,
  SQL_EXTEND,
  SQL_FAIL,
  SQL_LEASE,
  SQL_REAP,
  SQL_STATS,
  type JobKind,
  type JobRow,
  type QueueStats,
} from "../../lib/jobs-shared";

export type ClaimedJob = JobRow & { kind: JobKind; owner: string };

export interface JobStore {
  /** Asks for `kind` for `shop`, in `delayMs` (0 = now). Idempotent per (shop, kind). */
  enqueue(shop: string, kind: JobKind, delayMs?: number): Promise<void>;
  /** The oldest due job whose shop is free, with the shop's lease; null = nothing to do. */
  claim(owner: string, leaseMs?: number): Promise<ClaimedJob | null>;
  /** Extends the job's and the shop's lease; false = lost (another worker may have it now). */
  extend(job: ClaimedJob, leaseMs?: number): Promise<boolean>;
  /** Finished: removed, or re-queued when asked for again meanwhile. Releases the shop. */
  complete(job: ClaimedJob): Promise<{ deleted: number; requeued: number }>;
  /** Threw: tried again after `retryMs`, error kept (short). Releases the shop. */
  fail(job: ClaimedJob, error: string, retryMs: number): Promise<void>;
  /** Claims that kept dying are set aside for an hour. Returns how many. */
  reap(): Promise<number>;
  /** A named lease (shop-wide timers): true = ours for `ms`. */
  lease(key: string, owner: string, ms: number): Promise<boolean>;
  stats(): Promise<QueueStats>;
}

/** Runs one SQL statement with positional parameters and returns its rows. */
export type RawQuery = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

const int = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));

export function pgJobStore(query: RawQuery): JobStore {
  return {
    async enqueue(shop, kind, delayMs = 0) {
      await query(SQL_ENQUEUE, [shop, kind, Math.max(0, Math.round(delayMs))]);
    },
    async claim(owner, leaseMs = LEASE_MS) {
      const rows = await query(SQL_CLAIM, [owner, leaseMs, MAX_ATTEMPTS]);
      const r = rows[0];
      if (!r) return null;
      return { id: String(r.id), shop: String(r.shop), kind: String(r.kind) as JobKind, attempts: int(r.attempts), version: int(r.version), owner };
    },
    async extend(job, leaseMs = LEASE_MS) {
      const rows = await query(SQL_EXTEND, [job.id, job.owner, leaseMs]);
      const held = rows[0]?.held;
      return held === true || held === "t" || held === "true";
    },
    async complete(job) {
      const r = (await query(SQL_COMPLETE, [job.id, job.owner, job.version, job.shop]))[0] ?? {};
      return { deleted: int(r.deleted), requeued: int(r.requeued) };
    },
    async fail(job, error, retryMs) {
      await query(SQL_FAIL, [job.id, job.owner, error, Math.max(0, Math.round(retryMs)), job.shop]);
    },
    async reap() {
      return (await query(SQL_REAP, [MAX_ATTEMPTS])).length;
    },
    async lease(key, owner, ms) {
      return (await query(SQL_LEASE, [key, owner, Math.max(1, Math.round(ms))])).length > 0;
    },
    async stats() {
      const r = (await query(SQL_STATS, []))[0] ?? {};
      return { due: int(r.due), running: int(r.running), later: int(r.later), failing: int(r.failing), oldestDueSec: int(r.oldestDueSec) };
    },
  };
}

const prismaQuery: RawQuery = (sql, params) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);

let current: JobStore | null = null;

/** The app's job store (Postgres through Prisma). */
export function jobStore(): JobStore {
  return (current ??= pgJobStore(prismaQuery));
}

/** Tests: use another store (null = back to Postgres). */
export function setJobStore(store: JobStore | null): void {
  current = store;
}

// In-process wake-up: an enqueue here lets this process's idle workers look at once.
const wakers = new Set<() => void>();
export function onEnqueue(wake: () => void): () => void {
  wakers.add(wake);
  return () => wakers.delete(wake);
}

/** Enqueues a job and wakes this process's idle workers. Never throws (logged): a lost enqueue is retried by the hourly tick. */
export async function enqueueJob(shop: string, kind: JobKind, delayMs = 0): Promise<boolean> {
  try {
    await jobStore().enqueue(shop, kind, delayMs);
    if (delayMs <= 0) for (const w of wakers) w();
    return true;
  } catch (e) {
    console.error(`[jobs] ${shop} ${kind}: enqueue failed`, e);
    return false;
  }
}
