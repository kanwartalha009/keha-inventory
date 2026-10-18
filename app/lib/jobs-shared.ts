/**
 * Background job queue (DB scale #2, audit 2026-10-17) — the pure part: job kinds, modes,
 * timings and the SQL every instance runs. Postgres only, no new dependency.
 *
 * Model. One `Job` row per (shop, kind) that is wanted — backfill, nightly, compute, alerts,
 * accuracy (hourly snapshot / grade), plans (the 6-hourly plan check; perf 2026-10-18: both were
 * serial loops over every shop in one timer) —
 * claimed by any worker with `FOR UPDATE SKIP LOCKED`, so two instances never take the same row.
 * A `JobLease` row per shop ("shop:<domain>") is the per-shop lock: a claim takes the job AND the
 * shop's lease in ONE statement, so two jobs of one shop never run at once on any instance (the
 * backfill, the nightly sync and compute all write the same shop's rows). Leases expire
 * (`lockedUntil`): a worker that dies frees its shop after LEASE_MS; a live one extends both every
 * LEASE_MS / 3. Timers that work across every shop (outbox, purge, Monday email …) take a
 * "tick:<name>" lease, so one instance runs each.
 *
 * Enqueue is an upsert on (shop, kind): asking again while queued keeps one row (the earlier
 * runAt wins); asking while it RUNS bumps `version`, and completion then re-queues the row at the
 * asked time instead of deleting it — "run again after this one", never twice at once.
 *
 * Every statement is a single SQL statement (CTEs where several rows change), every time comes
 * from the database clock (`now() AT TIME ZONE 'UTC'`, the zone Prisma stores DateTime in), and
 * there are no session-level locks: safe behind PgBouncer in transaction mode.
 */

// "recheck": the weekly sales re-check (services/sync/weekly-recheck.server).
export const JOB_KINDS = ["backfill", "nightly", "compute", "alerts", "maintenance", "accuracy", "plans", "recheck"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * The shop of the store-wide jobs (`maintenance`: the fact tables' monthly partitions, DB scale
 * "before 1,000 stores"): one row, one lease ("shop:*"), never a real shop domain.
 */
export const GLOBAL_JOB_SHOP = "*";

export function isJobKind(v: unknown): v is JobKind {
  return typeof v === "string" && (JOB_KINDS as readonly string[]).includes(v);
}

/**
 * WORKER_MODE: `web` serves pages only (no timers, no jobs), `worker` runs timers and jobs only
 * (a second Railway service from the same build), `all` both — the default, today's single
 * service. Unknown values mean `all` (fail open: jobs never silently stop).
 */
export type WorkerMode = "web" | "worker" | "all";
export function workerMode(v: string | undefined): WorkerMode {
  const m = (v ?? "").trim().toLowerCase();
  return m === "web" || m === "worker" ? m : "all";
}

/**
 * Above this many planned variants a store's nightly compute holds a CPU core for tens of seconds
 * (docs/SCALE.md). In production with WORKER_MODE=all that core also serves pages: compute yields
 * every 100 variants, but page loads still slow down. Production needs a separate worker service
 * (docs/OPERATIONS.md "Services"); compute logs a warning when it is missing.
 */
export const SHARED_LOOP_WARN_VARIANTS = 5000;

/** Should compute warn that pages and a large store's compute share one process? */
export function sharedLoopWarning(mode: WorkerMode, nodeEnv: string | undefined, variants: number): boolean {
  return mode === "all" && nodeEnv === "production" && variants > SHARED_LOOP_WARN_VARIANTS;
}

/** INVENTORY_WORKERS: jobs run at once per instance (default 2, 1–16). */
export const DEFAULT_WORKERS = 2;
export function workerCount(v: string | undefined): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(16, n) : DEFAULT_WORKERS;
}

/** A claimed job's lease (and its shop's): extended every LEASE_MS / 3 while it runs. */
export const LEASE_MS = 10 * 60 * 1000;
/** Idle workers look for work this often (an enqueue in the same process wakes them at once). */
export const POLL_MS = 5_000;
/** A claim that keeps dying (process crash, lost lease) is set aside for an hour after this many. */
export const MAX_ATTEMPTS = 5;
/** A job that threw waits before it is tried again: 1, 2, 4 … minutes, at most an hour. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 60_000 * 2 ** Math.max(0, attempts - 1));
}
/** Backfill throttled (ShopifyQL window): try again after this. */
export const THROTTLED_RETRY_MS = 60_000;
/** Nightly throttled: try again after this (the next hourly tick would too). */
export const NIGHTLY_THROTTLED_RETRY_MS = 5 * 60_000;

export const shopLeaseKey = (shop: string) => `shop:${shop}`;
export const tickLeaseKey = (name: string) => `tick:${name}`;

/** The database clock, in the zone Prisma stores DateTime in. */
const NOW = `(now() AT TIME ZONE 'UTC')`;
const ms = (p: string) => `(${p}::bigint * interval '1 millisecond')`;

/**
 * $1 shop, $2 kind, $3 delay ms. Queued: the earlier runAt wins. Running: version + 1 and runAt
 * = the asked time (completion re-queues instead of deleting).
 */
export const SQL_ENQUEUE = `
INSERT INTO "Job" ("id", "shop", "kind", "runAt", "version", "attempts", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, $1::text, $2::text, ${NOW} + ${ms("$3")}, 1, 0, ${NOW}, ${NOW})
ON CONFLICT ("shop", "kind") DO UPDATE SET
  "version" = "Job"."version" + 1,
  "updatedAt" = ${NOW},
  "runAt" = CASE
    WHEN "Job"."lockedUntil" IS NOT NULL AND "Job"."lockedUntil" > ${NOW} THEN EXCLUDED."runAt"
    ELSE LEAST("Job"."runAt", EXCLUDED."runAt")
  END
RETURNING "id"`;

/** The shop of the job `j` holds no live lease. */
const SHOP_FREE = `NOT EXISTS (SELECT 1 FROM "JobLease" l WHERE l."key" = 'shop:' || j."shop" AND l."lockedUntil" > ${NOW})`;

/**
 * $1 owner, $2 lease ms, $3 max attempts. Takes a due job whose shop is free, and the shop's lease,
 * in one statement. No row back = nothing to do (or the shop was taken meanwhile).
 *
 * Perf 2026-10-18 (#12): two steps, each on its own partial index (migration
 * 20261018600200_job_claim_index), so a claim never walks past running jobs: first a job whose
 * worker died (its lock expired; "Job_locked_idx" on lockedUntil, only locked rows), else the
 * oldest due unlocked job ("Job_claim_idx" on runAt, id WHERE lockedUntil IS NULL). Before, one
 * scan in runAt order skipped every locked row in front: 0.6 ms with 2,000–20,000 queued jobs and
 * few running, 28 ms with 50,000 of 100,000 running; now ~0.7 ms in both (sandbox Postgres 16).
 */
export const SQL_CLAIM = `
WITH stale AS (
  SELECT j."id", j."shop" FROM "Job" j
  WHERE j."lockedUntil" IS NOT NULL AND j."lockedUntil" < ${NOW}
    AND j."runAt" <= ${NOW}
    AND j."attempts" < $3::int
    AND ${SHOP_FREE}
  ORDER BY j."runAt", j."id"
  LIMIT 1
  FOR UPDATE SKIP LOCKED
), fresh AS (
  SELECT j."id", j."shop" FROM "Job" j
  WHERE NOT EXISTS (SELECT 1 FROM stale)
    AND j."lockedUntil" IS NULL
    AND j."runAt" <= ${NOW}
    AND j."attempts" < $3::int
    AND ${SHOP_FREE}
  ORDER BY j."runAt", j."id"
  LIMIT 1
  FOR UPDATE SKIP LOCKED
), picked AS (
  SELECT "id", "shop" FROM stale UNION ALL SELECT "id", "shop" FROM fresh
), lease AS (
  INSERT INTO "JobLease" ("key", "shop", "owner", "lockedUntil")
  SELECT 'shop:' || p."shop", p."shop", $1::text, ${NOW} + ${ms("$2")} FROM picked p
  ON CONFLICT ("key") DO UPDATE SET "owner" = EXCLUDED."owner", "lockedUntil" = EXCLUDED."lockedUntil", "shop" = EXCLUDED."shop"
  WHERE "JobLease"."lockedUntil" <= ${NOW}
  RETURNING "key"
)
UPDATE "Job" j SET
  "lockedUntil" = ${NOW} + ${ms("$2")},
  "lockedBy" = $1::text,
  "attempts" = j."attempts" + 1,
  "updatedAt" = ${NOW}
FROM picked p
WHERE j."id" = p."id" AND EXISTS (SELECT 1 FROM lease)
RETURNING j."id", j."shop", j."kind", j."attempts", j."version"`;

/** $1 job id, $2 owner, $3 lease ms. Extends the job and its shop's lease; held = both still ours. */
export const SQL_EXTEND = `
WITH j AS (
  UPDATE "Job" SET "lockedUntil" = ${NOW} + ${ms("$3")}, "updatedAt" = ${NOW}
  WHERE "id" = $1::text AND "lockedBy" = $2::text
  RETURNING "shop"
), leased AS (
  UPDATE "JobLease" jl SET "lockedUntil" = ${NOW} + ${ms("$3")}
  FROM j WHERE jl."key" = 'shop:' || j."shop" AND jl."owner" = $2::text
  RETURNING jl."key"
)
SELECT ((SELECT count(*) FROM j) = 1 AND (SELECT count(*) FROM leased) = 1) AS "held"`;

/**
 * $1 job id, $2 owner, $3 version claimed, $4 shop. Done: the row goes — unless it was asked for
 * again while running (version moved), then it is unlocked for its new runAt. The shop's lease
 * is released either way.
 */
export const SQL_COMPLETE = `
WITH gone AS (
  DELETE FROM "Job" WHERE "id" = $1::text AND "lockedBy" = $2::text AND "version" = $3::int RETURNING "id"
), again AS (
  UPDATE "Job" SET "lockedUntil" = NULL, "lockedBy" = NULL, "attempts" = 0, "lastError" = NULL, "updatedAt" = ${NOW}
  WHERE "id" = $1::text AND "lockedBy" = $2::text AND "version" <> $3::int
  RETURNING "id"
), freed AS (
  DELETE FROM "JobLease" WHERE "key" = 'shop:' || $4::text AND "owner" = $2::text RETURNING "key"
)
SELECT (SELECT count(*) FROM gone)::int AS "deleted", (SELECT count(*) FROM again)::int AS "requeued", (SELECT count(*) FROM freed)::int AS "freed"`;

/** $1 job id, $2 owner, $3 error (short), $4 retry delay ms, $5 shop. Unlocks for a later retry; releases the lease. */
export const SQL_FAIL = `
WITH f AS (
  UPDATE "Job" SET "lockedUntil" = NULL, "lockedBy" = NULL, "lastError" = left($3::text, 500),
    "runAt" = GREATEST("runAt", ${NOW} + ${ms("$4")}), "updatedAt" = ${NOW}
  WHERE "id" = $1::text AND "lockedBy" = $2::text
  RETURNING "id"
), freed AS (
  DELETE FROM "JobLease" WHERE "key" = 'shop:' || $5::text AND "owner" = $2::text RETURNING "key"
)
SELECT (SELECT count(*) FROM f)::int AS "failed", (SELECT count(*) FROM freed)::int AS "freed"`;

/**
 * $1 max attempts. Jobs whose claims kept dying (attempts ≥ max, not running): set aside for an
 * hour with a note, attempts reset — they are never claimed in a crash loop.
 */
export const SQL_REAP = `
UPDATE "Job" SET "attempts" = 0, "runAt" = ${NOW} + interval '1 hour', "lastError" = 'set aside: ' || "attempts" || ' claims did not finish', "updatedAt" = ${NOW}
WHERE "attempts" >= $1::int AND ("lockedUntil" IS NULL OR "lockedUntil" < ${NOW})
RETURNING "id"`;

/** $1 key, $2 owner, $3 ms. Takes a lease when free or expired (or already ours); a row back = held. */
export const SQL_LEASE = `
INSERT INTO "JobLease" ("key", "shop", "owner", "lockedUntil")
VALUES ($1::text, NULL, $2::text, ${NOW} + ${ms("$3")})
ON CONFLICT ("key") DO UPDATE SET "owner" = EXCLUDED."owner", "lockedUntil" = EXCLUDED."lockedUntil"
WHERE "JobLease"."lockedUntil" <= ${NOW} OR "JobLease"."owner" = EXCLUDED."owner"
RETURNING "key"`;

/** Queue health for /health: counts and the oldest due job's wait (seconds). */
export const SQL_STATS = `
SELECT
  count(*) FILTER (WHERE "runAt" <= ${NOW} AND ("lockedUntil" IS NULL OR "lockedUntil" < ${NOW}))::int AS "due",
  count(*) FILTER (WHERE "lockedUntil" > ${NOW})::int AS "running",
  count(*) FILTER (WHERE "runAt" > ${NOW} AND ("lockedUntil" IS NULL OR "lockedUntil" < ${NOW}))::int AS "later",
  count(*) FILTER (WHERE "lastError" IS NOT NULL)::int AS "failing",
  COALESCE(EXTRACT(EPOCH FROM (${NOW} - min("runAt") FILTER (WHERE "runAt" <= ${NOW} AND ("lockedUntil" IS NULL OR "lockedUntil" < ${NOW})))), 0)::int AS "oldestDueSec"
FROM "Job"`;

export type JobRow = { id: string; shop: string; kind: string; attempts: number; version: number };
export type QueueStats = { due: number; running: number; later: number; failing: number; oldestDueSec: number };
