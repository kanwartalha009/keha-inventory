/**
 * Perf 2026-10-18 (#12): the hourly accuracy snapshot / grade and the 6-hourly plan check run as
 * one queued job per store (they were serial loops over every store inside one timer), and the
 * queue's claim has an index for its usual path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma();
  return { default: db.client, __fake: db };
});
const m = vi.hoisted(() => ({
  runAccuracy: vi.fn(async (_shop: string, _now: Date) => ({ status: "ok", snapshot: "not_due", grade: "exists" })),
  syncPlanForShop: vi.fn(async (_shop: string, _getAdmin: unknown) => "active"),
  pricingConfigured: vi.fn(() => true),
}));
vi.mock("../app/services/accuracy.server", async (orig) => ({ ...(await orig<object>()), runAccuracy: m.runAccuracy }));
vi.mock("../app/services/app-pricing.server", () => ({ syncPlanForShop: m.syncPlanForShop, pricingConfigured: m.pricingConfigured }));
vi.mock("../app/shopify.server", () => ({ unauthenticated: { admin: vi.fn() } }));

import * as dbModule from "../app/db.server";
import { accuracyTick } from "../app/services/accuracy.server";
import { queuePlanChecks } from "../app/services/scheduler.server";
import { setJobStore } from "../app/services/jobs/queue.server";
import { runOneJob } from "../app/services/jobs/worker.server";
import { jobHandlers } from "../app/services/jobs/handlers.server";
import { JOB_KINDS } from "../app/lib/jobs-shared";
import { createMemoryJobStore, type MemoryJobStore } from "./helpers/memory-job-store";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
let store: MemoryJobStore;

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  store = createMemoryJobStore(Date.parse("2026-10-18T10:00:00Z"));
  setJobStore(store);
});

describe("per-store jobs", () => {
  it("accuracy: one job per installed store (not sample data, not uninstalled), each run by a worker", async () => {
    db.tables.shop = [
      { domain: "a.myshopify.com", uninstalledAt: null },
      { domain: "b.myshopify.com", uninstalledAt: null },
      { domain: "a.myshopify.com#sample", uninstalledAt: null },
      { domain: "gone.myshopify.com", uninstalledAt: new Date() },
    ];
    expect(await accuracyTick()).toBe(2);
    expect(store.jobs.map((j) => `${j.kind}:${j.shop}`).sort()).toEqual(["accuracy:a.myshopify.com", "accuracy:b.myshopify.com"]);
    const handlers = jobHandlers({ getAdmin: vi.fn(), sleep: async () => {} });
    expect(await runOneJob(handlers, "w1", { store })).toBe("done");
    expect(await runOneJob(handlers, "w1", { store })).toBe("done");
    expect(m.runAccuracy.mock.calls.map((c) => c[0]).sort()).toEqual(["a.myshopify.com", "b.myshopify.com"]);
    expect(store.jobs).toEqual([]);
  });

  it("plans: one job per store with a session when the Partner API is set up; none otherwise", async () => {
    db.tables.session = [
      { id: "s1", shop: "a.myshopify.com" },
      { id: "s2", shop: "a.myshopify.com" },
      { id: "s3", shop: "c.myshopify.com" },
    ];
    m.pricingConfigured.mockReturnValueOnce(false);
    expect(await queuePlanChecks()).toBe(0);
    expect(await queuePlanChecks()).toBe(2);
    const getAdmin = vi.fn();
    const handlers = jobHandlers({ getAdmin, sleep: async () => {} });
    await runOneJob(handlers, "w1", { store });
    await runOneJob(handlers, "w1", { store });
    expect(m.syncPlanForShop.mock.calls.map((c) => c[0]).sort()).toEqual(["a.myshopify.com", "c.myshopify.com"]);
    expect(m.syncPlanForShop.mock.calls[0]![1]).toBe(getAdmin);
  });

  it("every job kind has a handler", () => {
    const handlers = jobHandlers({ getAdmin: vi.fn(), sleep: async () => {} });
    for (const k of JOB_KINDS) expect(typeof handlers[k], k).toBe("function");
  });
});

describe("the claim index", () => {
  it("a migration creates a partial index for the claim's usual path (unlocked jobs by runAt, id)", () => {
    const dir = join(__dirname, "..", "prisma", "migrations");
    const sql = readdirSync(dir).filter((d) => !d.endsWith(".toml")).map((d) => readFileSync(join(dir, d, "migration.sql"), "utf8")).join("\n");
    expect(sql).toMatch(/CREATE INDEX (CONCURRENTLY )?"Job_claim_idx" ON "Job"\s*\("runAt", "id"\)\s*WHERE "lockedUntil" IS NULL/);
  });
});
