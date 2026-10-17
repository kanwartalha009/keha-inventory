/**
 * Scheduler data work through the job queue (DB scale #2; before: one serial loop in the web
 * process with in-memory locks). The hourly data tick only QUEUES — per installed shop the
 * backfill until finished, then the nightly sync when due — and the workers run the jobs:
 * a backfill job keeps the per-shop bounds of the old tick (6 steps, 30 s of throttle waits,
 * review H4) and queues itself again while in progress; compute is its own job; a shop's jobs
 * never overlap; the heartbeat for /health stays truthful. The store is the in-memory one that
 * tests/jobs-store.test.ts holds to the Postgres SQL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma();
  return { default: db.client, __fake: db };
});
const m = vi.hoisted(() => ({
  runBackfill: vi.fn(async (_shop: string, _deps: unknown) => "progress"),
  runNightly: vi.fn(async (_shop: string, _deps: unknown) => "done"),
  computeAfterSync: vi.fn(async (_shop: string) => {}),
}));
vi.mock("../app/shopify.server", () => ({ unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/lib/nova.server", () => ({ flushOutbox: vi.fn(), scrubDeliveredOutbox: vi.fn() }));
vi.mock("../app/services/gdpr.server", () => ({ purgeDueShops: vi.fn() }));
vi.mock("../app/services/pii-log.server", () => ({ purgeOldPersonalDataLogs: vi.fn() }));
vi.mock("../app/services/app-pricing.server", () => ({ syncAllPlans: vi.fn() }));
vi.mock("../app/services/compute.server", () => ({ computeAfterSync: m.computeAfterSync }));
vi.mock("../app/services/sync/nightly.server", () => ({ runNightly: m.runNightly }));
vi.mock("../app/services/sync/backfill.server", async (orig) => {
  const real = await orig<typeof import("../app/services/sync/backfill.server")>();
  return { ...real, runBackfill: m.runBackfill };
});

import * as dbModule from "../app/db.server";
import { dataTick, schedulerHeartbeat, startScheduler } from "../app/services/scheduler.server";
import { withShopLock, type DataJobDeps } from "../app/services/sync/backfill.server";
import { setJobStore } from "../app/services/jobs/queue.server";
import { runOneJob, startWorkers } from "../app/services/jobs/worker.server";
import { jobHandlers } from "../app/services/jobs/handlers.server";
import { NIGHTLY_THROTTLED_RETRY_MS, THROTTLED_RETRY_MS, workerCount, workerMode } from "../app/lib/jobs-shared";
import { createMemoryJobStore, type MemoryJobStore } from "./helpers/memory-job-store";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const NOW = Date.parse("2026-10-17T04:30:00Z"); // 06:30 in Madrid: nightly due for a shop not run today
let store: MemoryJobStore;
const handlers = () => jobHandlers({ getAdmin: vi.fn(), sleep: async () => {} });

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  store = createMemoryJobStore(NOW);
  setJobStore(store);
  db.tables.session = [
    { id: "1", shop: "new.myshopify.com" },
    { id: "2", shop: "done.myshopify.com" },
    { id: "3", shop: "done.myshopify.com" },
    { id: "4", shop: "half.myshopify.com" },
    { id: "5", shop: "ran.myshopify.com" },
    { id: "6", shop: "gone.myshopify.com" },
  ];
  const finished = { finishedAt: "2026-10-10T00:00:00Z", datasets: { products: { done: 1, total: 1 } } };
  db.tables.shop = [
    { domain: "done.myshopify.com", timezone: "Europe/Madrid", uninstalledAt: null, lastNightlyAt: new Date("2026-10-16T01:10:00Z"), backfillState: finished },
    { domain: "ran.myshopify.com", timezone: "Europe/Madrid", uninstalledAt: null, lastNightlyAt: new Date("2026-10-17T01:10:00Z"), backfillState: finished },
    { domain: "half.myshopify.com", timezone: "Europe/Madrid", uninstalledAt: null, lastNightlyAt: null, backfillState: { datasets: { products: { done: 1, total: 1 } } } },
    { domain: "gone.myshopify.com", timezone: "UTC", uninstalledAt: new Date("2026-10-16T00:00:00Z"), lastNightlyAt: null, backfillState: {} },
  ];
});
afterEach(() => setJobStore(null));

const queued = () => store.jobs.map((j) => `${j.kind}:${j.shop}`).sort();

describe("hourly data tick: queues, never runs inline", () => {
  it("backfill for shops not finished, nightly only where due; uninstalled skipped; nothing runs in the tick", async () => {
    const counts = await dataTick({ now: () => NOW });
    expect(counts).toEqual({ backfill: 2, nightly: 1, not_due: 1, skipped: 1 });
    expect(queued()).toEqual(["backfill:half.myshopify.com", "backfill:new.myshopify.com", "nightly:done.myshopify.com"]);
    expect(m.runBackfill).not.toHaveBeenCalled();
    expect(m.runNightly).not.toHaveBeenCalled();
    const hb = schedulerHeartbeat();
    expect(hb.lastDataTickAt).toBe(new Date(NOW).toISOString());
    expect(hb.dataTickRunning).toBe(false);
    expect(JSON.parse(hb.lastDataTick!)).toEqual(counts);
  });

  it("queuing twice keeps one job per shop and kind", async () => {
    await dataTick({ now: () => NOW });
    await dataTick({ now: () => NOW });
    expect(store.jobs).toHaveLength(3);
  });

  it("skips a tick while the previous one is still running", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const findMany = (db.client.session as { findMany: (...a: unknown[]) => Promise<unknown> }).findMany;
    (db.client.session as { findMany: unknown }).findMany = async (...a: unknown[]) => {
      await slow;
      return findMany(...a);
    };
    const first = dataTick({ now: () => NOW });
    expect(await dataTick({ now: () => NOW })).toEqual({ overlap: 1 });
    release();
    await first;
    (db.client.session as { findMany: unknown }).findMany = findMany;
  });
});

describe("job handlers", () => {
  it("review H4 kept per job: a backfill job runs 6 steps with its own 30 s throttle-wait budget, then queues itself again", async () => {
    const slept: number[] = [];
    const h = jobHandlers({ getAdmin: vi.fn(), sleep: async (ms) => void slept.push(ms) });
    await store.enqueue("new.myshopify.com", "backfill");
    const job = (await store.claim("w"))!;
    expect(await h.backfill(job)).toBe("progress");
    const deps = m.runBackfill.mock.calls[0][1] as DataJobDeps;
    expect(deps.maxSteps).toBe(6);
    await deps.throttleSleep!(20_000);
    await expect(deps.throttleSleep!(15_000)).rejects.toThrow("exceeds the tick budget");
    expect(slept).toEqual([20_000]);
    // In progress: asked for again while running → re-queued when it completes.
    expect(await store.complete(job)).toEqual({ deleted: 0, requeued: 1 });
    // Compute is queued as its own job (deduplicated), not run inside the sync.
    await deps.afterSync!("new.myshopify.com");
    await deps.afterSync!("new.myshopify.com");
    expect(queued()).toEqual(["backfill:new.myshopify.com", "compute:new.myshopify.com"]);
    expect(m.computeAfterSync).not.toHaveBeenCalled();
  });

  it("throttled: backfill retried in a minute, nightly in five; done / error: nothing queued", async () => {
    const h = handlers();
    m.runBackfill.mockResolvedValueOnce("throttled");
    await store.enqueue("a.myshopify.com", "backfill");
    let job = (await store.claim("w"))!;
    await h.backfill(job);
    await store.complete(job);
    expect(store.jobs[0].runAt - store.clock.now).toBe(THROTTLED_RETRY_MS);
    m.runNightly.mockResolvedValueOnce("throttled");
    await store.enqueue("b.myshopify.com", "nightly");
    job = (await store.claim("w"))!;
    await h.nightly(job);
    await store.complete(job);
    expect(store.jobs.find((j) => j.kind === "nightly")!.runAt - store.clock.now).toBe(NIGHTLY_THROTTLED_RETRY_MS);
    m.runBackfill.mockResolvedValueOnce("done");
    await store.enqueue("c.myshopify.com", "backfill");
    store.jobs.find((j) => j.shop === "a.myshopify.com")!.runAt = store.clock.now + 999_999;
    job = (await store.claim("w"))!;
    expect(job.shop).toBe("c.myshopify.com");
    await h.backfill(job);
    expect(await store.complete(job)).toEqual({ deleted: 1, requeued: 0 });
  });

  it("compute and alerts jobs run their work for the job's shop", async () => {
    const h = handlers();
    await store.enqueue("done.myshopify.com", "compute");
    await h.compute((await store.claim("w"))!);
    expect(m.computeAfterSync).toHaveBeenCalledWith("done.myshopify.com");
    expect(await h.alerts({ id: "x", shop: "nope.myshopify.com", kind: "alerts", attempts: 1, version: 1, owner: "w" })).toBe("skipped");
  });
});

describe("workers", () => {
  it("run every queued job, at most `count` at once, never two of one shop at once", async () => {
    let running = 0;
    let max = 0;
    const perShop = new Map<string, number>();
    const log: string[] = [];
    const slow = async (shop: string, kind: string) => {
      running++;
      max = Math.max(max, running);
      perShop.set(shop, (perShop.get(shop) ?? 0) + 1);
      expect(perShop.get(shop)).toBe(1);
      await new Promise((r) => setTimeout(r, 5));
      perShop.set(shop, perShop.get(shop)! - 1);
      running--;
      log.push(`${kind}:${shop}`);
      return "done";
    };
    const h = { backfill: (j: { shop: string }) => slow(j.shop, "backfill"), nightly: (j: { shop: string }) => slow(j.shop, "nightly"), compute: (j: { shop: string }) => slow(j.shop, "compute"), alerts: (j: { shop: string }) => slow(j.shop, "alerts") };
    for (const s of ["a", "b", "c"]) for (const k of ["backfill", "compute", "alerts"] as const) await store.enqueue(`${s}.myshopify.com`, k);
    const w = startWorkers(h, { count: 2, pollMs: 5 });
    await vi.waitFor(() => expect(log).toHaveLength(9), { timeout: 5000 });
    await w.stop();
    expect(max).toBe(2);
    expect(store.jobs).toHaveLength(0);
    expect(store.leases.size).toBe(0);
    expect(schedulerHeartbeat()).toMatchObject({ workers: 0, jobsRunning: 0, lastJob: expect.stringMatching(/:done$/) });
  });

  it("a job that throws is kept for a retry with its error; the loop carries on", async () => {
    const boom = { backfill: async () => { throw new Error("db down"); }, nightly: async () => "x", compute: async () => "x", alerts: async () => "x" };
    await store.enqueue("a.myshopify.com", "backfill");
    expect(await runOneJob(boom, "w")).toBe("failed");
    expect(store.jobs[0]).toMatchObject({ lastError: "Error: db down", lockedBy: null });
    expect(store.jobs[0].runAt).toBeGreaterThan(store.clock.now);
    expect(await runOneJob(boom, "w")).toBe("idle");
  });

  it("a shop already busy in this process is put back, not run twice", async () => {
    let release!: () => void;
    const held = withShopLock("a.myshopify.com", () => new Promise<string>((r) => (release = () => r("x"))));
    await store.enqueue("a.myshopify.com", "compute");
    expect(await runOneJob(handlers(), "w")).toBe("busy");
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0].runAt).toBeGreaterThan(store.clock.now);
    release();
    await held;
  });
});

describe("WORKER_MODE / INVENTORY_WORKERS", () => {
  it("parse with safe defaults (all, 2)", () => {
    expect(workerMode(undefined)).toBe("all");
    expect(workerMode("WEB")).toBe("web");
    expect(workerMode("worker")).toBe("worker");
    expect(workerMode("nonsense")).toBe("all");
    expect(workerCount(undefined)).toBe(2);
    expect(workerCount("4")).toBe(4);
    expect(workerCount("0")).toBe(2);
    expect(workerCount("99")).toBe(16);
  });

  it("web mode starts no timers and no workers; the heartbeat says so", () => {
    const g = globalThis as { __kehaInvSchedulerStarted?: boolean; __kehaInvSchedulerMode?: string };
    g.__kehaInvSchedulerStarted = false;
    process.env.WORKER_MODE = "web";
    try {
      startScheduler();
      expect(schedulerHeartbeat()).toMatchObject({ started: false, mode: "web" });
    } finally {
      delete process.env.WORKER_MODE;
      delete g.__kehaInvSchedulerMode;
    }
  });
});
