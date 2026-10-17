/**
 * Review fix: boot runs every hourly job once, including instant alerts and accuracy
 * (before, those two waited up to an hour after every restart).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  alertsTick: vi.fn(async () => {}),
  runAccuracyAllShops: vi.fn(async () => ({})),
  runMondayEmailsAllShops: vi.fn(async () => ({ sent: 0, failed: 0, skipped: 0 })),
  purgeDueShops: vi.fn(async () => []),
  flushOutbox: vi.fn(async () => ({ processed: 0, sent: 0, failed: 0 })),
}));

vi.mock("../app/db.server", () => ({ default: { session: { findMany: vi.fn(async () => []) }, shop: { findMany: vi.fn(async () => []) } } }));
vi.mock("../app/shopify.server", () => ({ unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/lib/nova.server", () => ({ flushOutbox: m.flushOutbox, scrubDeliveredOutbox: vi.fn(async () => 0) }));
vi.mock("../app/services/gdpr.server", () => ({ purgeDueShops: m.purgeDueShops }));
vi.mock("../app/services/pii-log.server", () => ({ purgeOldPersonalDataLogs: vi.fn(async () => 0) }));
vi.mock("../app/services/app-pricing.server", () => ({ syncAllPlans: vi.fn(async () => ({ checked: 0 })) }));
vi.mock("../app/services/compute.server", () => ({ computeAfterSync: vi.fn() }));
vi.mock("../app/services/sync/nightly.server", () => ({ runNightly: vi.fn() }));
vi.mock("../app/services/monday.server", () => ({ runMondayEmailsAllShops: m.runMondayEmailsAllShops }));
vi.mock("../app/services/accuracy.server", () => ({ runAccuracyAllShops: m.runAccuracyAllShops }));
vi.mock("../app/services/alerts.server", () => ({ alertsTick: m.alertsTick }));

import { HOURLY_JOBS, startScheduler } from "../app/services/scheduler.server";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  (globalThis as { __kehaInvSchedulerStarted?: boolean }).__kehaInvSchedulerStarted = false;
  delete process.env.INVENTORY_DISABLE_INTERNAL_CRON;
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("scheduler boot", () => {
  it("the hourly list includes alerts and accuracy", () => {
    expect(HOURLY_JOBS.map((j) => j.name)).toEqual(["purge", "plan sync", "data sync", "monday email", "accuracy", "alerts", "partitions"]);
  });

  it("boot runs alerts and accuracy once, then hourly", async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(m.alertsTick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(m.alertsTick).toHaveBeenCalledTimes(1);
    expect(m.runAccuracyAllShops).toHaveBeenCalledTimes(1);
    expect(m.runMondayEmailsAllShops).toHaveBeenCalledTimes(1);
    expect(m.purgeDueShops).toHaveBeenCalledTimes(1);
    expect(m.flushOutbox).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(m.alertsTick).toHaveBeenCalledTimes(2);
    expect(m.runAccuracyAllShops).toHaveBeenCalledTimes(2);
  });
});
