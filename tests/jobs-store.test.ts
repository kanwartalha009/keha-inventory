/**
 * The job queue (DB scale #2): one contract, run against
 *  - the Postgres store — the app's exact SQL (lib/jobs-shared) through psql on a fresh database
 *    with every migration applied (skipped where no Postgres is reachable, see helpers/pg), plus
 *    real concurrency: parallel sessions claiming at once;
 *  - the in-memory store the scheduler tests use (helpers/memory-job-store), so it cannot drift.
 * Time moving on = every timestamp shifted back (Postgres) or the clock moved (memory).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, type JobKind } from "../app/lib/jobs-shared";
import { pgJobStore, type JobStore } from "../app/services/jobs/queue.server";
import { createMemoryJobStore, type MemoryJobStore } from "./helpers/memory-job-store";
import { PG_AVAILABLE, dropDb, freshDb, psql, psqlAsync, psqlQuery, bind } from "./helpers/pg";
import { SQL_CLAIM } from "../app/lib/jobs-shared";

type Row = { attempts: number; version: number; lastError: string | null; locked: boolean; runsInMs: number } | null;
type Harness = { store: JobStore; advance: (ms: number) => Promise<void>; row: (shop: string, kind: JobKind) => Promise<Row>; reset: () => Promise<void> };

const DB = "keha_jobs_test";

function memoryHarness(): Harness {
  let m: MemoryJobStore = createMemoryJobStore();
  const h: Harness = {
    store: null as unknown as JobStore,
    advance: async (ms) => void (m.clock.now += ms),
    row: async (shop, kind) => {
      const j = m.jobs.find((x) => x.shop === shop && x.kind === kind);
      return j ? { attempts: j.attempts, version: j.version, lastError: j.lastError, locked: j.lockedUntil !== null && j.lockedUntil > m.clock.now, runsInMs: j.runAt - m.clock.now } : null;
    },
    reset: async () => {
      m = createMemoryJobStore();
      h.store = m;
    },
  };
  return h;
}

function pgHarness(): Harness {
  const store = pgJobStore(psqlQuery(DB));
  return {
    store,
    advance: async (ms) => {
      psql(DB, `UPDATE "Job" SET "runAt" = "runAt" - interval '${ms} milliseconds', "lockedUntil" = "lockedUntil" - interval '${ms} milliseconds'`);
      psql(DB, `UPDATE "JobLease" SET "lockedUntil" = "lockedUntil" - interval '${ms} milliseconds'`);
    },
    row: async (shop, kind) => {
      const r = psql(
        DB,
        bind(
          `SELECT "attempts", "version", "lastError", ("lockedUntil" IS NOT NULL AND "lockedUntil" > (now() AT TIME ZONE 'UTC')) AS "locked", (EXTRACT(EPOCH FROM ("runAt" - (now() AT TIME ZONE 'UTC'))) * 1000)::bigint AS "runsInMs" FROM "Job" WHERE "shop" = $1 AND "kind" = $2`,
          [shop, kind],
        ),
      )[0];
      return r ? { attempts: Number(r.attempts), version: Number(r.version), lastError: (r.lastError as string) ?? null, locked: r.locked === "t", runsInMs: Number(r.runsInMs) } : null;
    },
    reset: async () => {
      psql(DB, `TRUNCATE "Job", "JobLease"`);
    },
  };
}

function contract(name: string, make: () => Harness) {
  describe(`job store contract: ${name}`, () => {
    const h = make();
    beforeEach(async () => h.reset());
    const A = "a.myshopify.com";
    const B = "b.myshopify.com";

    it("enqueue is idempotent per (shop, kind); a claim takes the job and its shop", async () => {
      await h.store.enqueue(A, "backfill");
      await h.store.enqueue(A, "backfill");
      await h.store.enqueue(A, "compute");
      expect((await h.store.stats()).due).toBe(2);
      const j = await h.store.claim("w1");
      expect(j).toMatchObject({ shop: A, attempts: 1 });
      // Same shop, other kind: waits for the shop.
      expect(await h.store.claim("w2")).toBeNull();
      expect(await h.store.complete(j!)).toEqual({ deleted: 1, requeued: 0 });
      const next = await h.store.claim("w2");
      expect(next?.shop).toBe(A);
      expect(next?.kind).toBe(j!.kind === "backfill" ? "compute" : "backfill");
    });

    it("other shops run side by side", async () => {
      await h.store.enqueue(A, "nightly");
      await h.store.enqueue(B, "nightly");
      const x = await h.store.claim("w1");
      const y = await h.store.claim("w2");
      expect(new Set([x?.shop, y?.shop])).toEqual(new Set([A, B]));
      expect((await h.store.stats()).running).toBe(2);
    });

    it("asked for again while it runs: re-queued when it finishes, never twice at once", async () => {
      await h.store.enqueue(A, "compute");
      const j = (await h.store.claim("w1"))!;
      await h.store.enqueue(A, "compute"); // e.g. a sync finished meanwhile
      expect(await h.store.claim("w2")).toBeNull();
      expect(await h.store.complete(j)).toEqual({ deleted: 0, requeued: 1 });
      const again = await h.store.claim("w2");
      expect(again).toMatchObject({ shop: A, kind: "compute", attempts: 1 });
    });

    it("a delay keeps it waiting; time moving on makes it due", async () => {
      await h.store.enqueue(A, "backfill", 60_000);
      expect(await h.store.claim("w1")).toBeNull();
      expect(await h.store.stats()).toMatchObject({ due: 0, later: 1 });
      await h.advance(61_000);
      expect(await h.store.claim("w1")).not.toBeNull();
    });

    it("a worker that dies frees the job and the shop when the lease runs out", async () => {
      await h.store.enqueue(A, "backfill");
      const dead = (await h.store.claim("w1", 60_000))!;
      expect(await h.store.claim("w2")).toBeNull();
      await h.advance(61_000);
      const taken = (await h.store.claim("w2"))!;
      expect(taken).toMatchObject({ id: dead.id, attempts: 2 });
      // The dead worker's late finish changes nothing.
      expect(await h.store.complete(dead)).toEqual({ deleted: 0, requeued: 0 });
      expect(await h.store.extend(dead)).toBe(false);
      expect(await h.store.extend(taken)).toBe(true);
      expect((await h.row(A, "backfill"))?.locked).toBe(true);
    });

    it("a job that threw waits for its retry, its error kept; claims that keep dying are set aside", async () => {
      await h.store.enqueue(A, "nightly");
      const j = (await h.store.claim("w1"))!;
      await h.store.fail(j, "boom", 120_000);
      const r = await h.row(A, "nightly");
      expect(r).toMatchObject({ lastError: "boom", locked: false });
      expect(r!.runsInMs).toBeGreaterThan(100_000);
      expect(await h.store.claim("w1")).toBeNull();
      expect((await h.store.stats()).failing).toBe(1);
      // MAX_ATTEMPTS claims that never finish (crash loop): no longer claimed, then set aside.
      await h.store.enqueue(B, "compute");
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        expect(await h.store.claim("w1", 1000)).not.toBeNull();
        await h.advance(2000);
      }
      expect(await h.store.claim("w1")).toBeNull();
      expect(await h.store.reap()).toBe(1);
      expect((await h.row(B, "compute"))!.attempts).toBe(0);
      expect((await h.row(B, "compute"))!.runsInMs).toBeGreaterThan(3_500_000);
    });

    it("named leases: one holder until it runs out (shop-wide timers run on one instance)", async () => {
      expect(await h.store.lease("tick:monday", "i1", 60_000)).toBe(true);
      expect(await h.store.lease("tick:monday", "i2", 60_000)).toBe(false);
      expect(await h.store.lease("tick:monday", "i1", 60_000)).toBe(true); // ours: renewed
      await h.advance(61_000);
      expect(await h.store.lease("tick:monday", "i2", 60_000)).toBe(true);
    });

    it("stats: due, running, later, failing, the oldest due wait", async () => {
      await h.store.enqueue(A, "backfill");
      await h.store.enqueue(B, "backfill", 600_000);
      await h.advance(30_000);
      const s = await h.store.stats();
      expect(s).toMatchObject({ due: 1, running: 0, later: 1, failing: 0 });
      expect(s.oldestDueSec).toBeGreaterThanOrEqual(29);
    });
  });
}

contract("in memory (scheduler tests)", memoryHarness);

describe.skipIf(!PG_AVAILABLE)("Postgres", () => {
  beforeAll(() => freshDb(DB));
  afterAll(() => dropDb(DB));
  contract("Postgres (the app's SQL)", pgHarness);

  it("parallel sessions claiming at once: each job once, each shop once (FOR UPDATE SKIP LOCKED + the shop lease)", async () => {
    psql(DB, `TRUNCATE "Job", "JobLease"`);
    const store = pgJobStore(psqlQuery(DB));
    const shops = Array.from({ length: 6 }, (_, i) => `s${i}.myshopify.com`);
    for (const s of shops) for (const k of ["backfill", "compute", "alerts"] as const) await store.enqueue(s, k);
    const claims = (await Promise.all(Array.from({ length: 14 }, (_, i) => psqlAsync(DB, bind(SQL_CLAIM, [`w${i}`, 600_000, MAX_ATTEMPTS]))))).flat();
    expect(claims.length).toBeGreaterThan(0);
    expect(new Set(claims.map((c) => c.id)).size).toBe(claims.length);
    expect(new Set(claims.map((c) => c.shop)).size).toBe(claims.length);
    // Leases match the claims: one per shop, owned by its claimer.
    const leases = psql(DB, `SELECT "key", "owner" FROM "JobLease"`);
    expect(leases.length).toBe(claims.length);
  }, 60_000);
});
