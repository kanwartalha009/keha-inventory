/**
 * In-memory JobStore with the semantics of the Postgres one (lib/jobs-shared SQL), for the
 * scheduler / worker tests. tests/jobs-store.test.ts runs one contract against both, so the two
 * cannot drift. Time comes from `now()` (tests move it).
 */
import { MAX_ATTEMPTS, type JobKind, type QueueStats } from "../../app/lib/jobs-shared";
import type { ClaimedJob, JobStore } from "../../app/services/jobs/queue.server";

export type MemJob = {
  id: string;
  shop: string;
  kind: JobKind;
  runAt: number;
  lockedUntil: number | null;
  lockedBy: string | null;
  attempts: number;
  lastError: string | null;
  version: number;
};

export type MemoryJobStore = JobStore & {
  jobs: MemJob[];
  leases: Map<string, { owner: string; until: number; shop: string | null }>;
  clock: { now: number };
};

export function createMemoryJobStore(start = Date.parse("2026-10-17T10:00:00Z")): MemoryJobStore {
  const clock = { now: start };
  const jobs: MemJob[] = [];
  const leases = new Map<string, { owner: string; until: number; shop: string | null }>();
  let seq = 0;
  const free = (j: MemJob) => j.lockedUntil === null || j.lockedUntil < clock.now;
  const shopFree = (shop: string) => {
    const l = leases.get(`shop:${shop}`);
    return !l || l.until <= clock.now;
  };
  return {
    jobs,
    leases,
    clock,
    async enqueue(shop, kind, delayMs = 0) {
      const at = clock.now + Math.max(0, delayMs);
      const j = jobs.find((x) => x.shop === shop && x.kind === kind);
      if (!j) {
        jobs.push({ id: `job${++seq}`, shop, kind, runAt: at, lockedUntil: null, lockedBy: null, attempts: 0, lastError: null, version: 1 });
        return;
      }
      j.version++;
      j.runAt = j.lockedUntil !== null && j.lockedUntil > clock.now ? at : Math.min(j.runAt, at);
    },
    async claim(owner, leaseMs = 600_000) {
      const due = jobs
        .filter((j) => j.runAt <= clock.now && free(j) && j.attempts < MAX_ATTEMPTS && shopFree(j.shop))
        .sort((a, b) => a.runAt - b.runAt || (a.id < b.id ? -1 : 1))[0];
      if (!due) return null;
      leases.set(`shop:${due.shop}`, { owner, until: clock.now + leaseMs, shop: due.shop });
      due.lockedUntil = clock.now + leaseMs;
      due.lockedBy = owner;
      due.attempts++;
      return { id: due.id, shop: due.shop, kind: due.kind, attempts: due.attempts, version: due.version, owner };
    },
    async extend(job: ClaimedJob, leaseMs = 600_000) {
      const j = jobs.find((x) => x.id === job.id && x.lockedBy === job.owner);
      const l = leases.get(`shop:${job.shop}`);
      if (j) j.lockedUntil = clock.now + leaseMs;
      if (j && l && l.owner === job.owner) l.until = clock.now + leaseMs;
      return !!j && !!l && l.owner === job.owner;
    },
    async complete(job) {
      const i = jobs.findIndex((x) => x.id === job.id && x.lockedBy === job.owner);
      let deleted = 0;
      let requeued = 0;
      if (i >= 0) {
        const j = jobs[i];
        if (j.version === job.version) {
          jobs.splice(i, 1);
          deleted = 1;
        } else {
          Object.assign(j, { lockedUntil: null, lockedBy: null, attempts: 0, lastError: null });
          requeued = 1;
        }
      }
      const l = leases.get(`shop:${job.shop}`);
      if (l?.owner === job.owner) leases.delete(`shop:${job.shop}`);
      return { deleted, requeued };
    },
    async fail(job, error, retryMs) {
      const j = jobs.find((x) => x.id === job.id && x.lockedBy === job.owner);
      if (j) Object.assign(j, { lockedUntil: null, lockedBy: null, lastError: error.slice(0, 500), runAt: Math.max(j.runAt, clock.now + retryMs) });
      const l = leases.get(`shop:${job.shop}`);
      if (l?.owner === job.owner) leases.delete(`shop:${job.shop}`);
    },
    async reap() {
      let n = 0;
      for (const j of jobs)
        if (j.attempts >= MAX_ATTEMPTS && free(j)) {
          Object.assign(j, { lastError: `set aside: ${j.attempts} claims did not finish`, attempts: 0, runAt: clock.now + 3_600_000 });
          n++;
        }
      return n;
    },
    async lease(key, owner, ms) {
      const l = leases.get(key);
      if (l && l.until > clock.now && l.owner !== owner) return false;
      leases.set(key, { owner, until: clock.now + ms, shop: l?.shop ?? null });
      return true;
    },
    async stats(): Promise<QueueStats> {
      const due = jobs.filter((j) => j.runAt <= clock.now && free(j));
      return {
        due: due.length,
        running: jobs.filter((j) => !free(j)).length,
        later: jobs.filter((j) => j.runAt > clock.now && free(j)).length,
        failing: jobs.filter((j) => j.lastError !== null).length,
        oldestDueSec: due.length ? Math.floor((clock.now - Math.min(...due.map((j) => j.runAt))) / 1000) : 0,
      };
    },
  };
}
