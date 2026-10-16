/**
 * Scheduler data tick (task 1.5): per installed shop, backfill until finished, then nightly;
 * overlap guard; a shop already busy is skipped; heartbeat exposed for /health.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma();
  return { default: db.client, __fake: db };
});
const m = vi.hoisted(() => ({
  runBackfill: vi.fn(async () => "progress"),
  runNightly: vi.fn(async () => "not_due"),
}));
vi.mock("../app/shopify.server", () => ({ unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/lib/nova.server", () => ({ flushOutbox: vi.fn(), scrubDeliveredOutbox: vi.fn() }));
vi.mock("../app/services/gdpr.server", () => ({ purgeDueShops: vi.fn() }));
vi.mock("../app/services/pii-log.server", () => ({ purgeOldPersonalDataLogs: vi.fn() }));
vi.mock("../app/services/app-pricing.server", () => ({ syncAllPlans: vi.fn() }));
vi.mock("../app/services/compute.server", () => ({ computeAfterSync: vi.fn() }));
vi.mock("../app/services/sync/nightly.server", () => ({ runNightly: m.runNightly }));
vi.mock("../app/services/sync/backfill.server", async (orig) => {
  const real = await orig<typeof import("../app/services/sync/backfill.server")>();
  return { ...real, runBackfill: m.runBackfill };
});

import * as dbModule from "../app/db.server";
import { dataTick, schedulerHeartbeat } from "../app/services/scheduler.server";
import { withShopLock, type DataJobDeps } from "../app/services/sync/backfill.server";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const deps: DataJobDeps = { getAdmin: vi.fn() };

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  db.tables.session = [
    { id: "1", shop: "new.myshopify.com" },
    { id: "2", shop: "done.myshopify.com" },
    { id: "3", shop: "done.myshopify.com" },
    { id: "4", shop: "half.myshopify.com" },
  ];
  db.tables.shop = [
    { domain: "done.myshopify.com", uninstalledAt: null, backfillState: { finishedAt: "2026-10-10T00:00:00Z" } },
    { domain: "half.myshopify.com", uninstalledAt: null, backfillState: { datasets: { products: { done: 1, total: 1 } } } },
  ];
});

describe("dataTick", () => {
  it("backfills shops without a finished backfill and runs nightly for the rest", async () => {
    const counts = await dataTick(deps);
    expect(counts).toEqual({ "backfill:progress": 2, "nightly:not_due": 1 });
    expect(m.runBackfill.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual(["half.myshopify.com", "new.myshopify.com"]);
    expect(m.runNightly).toHaveBeenCalledWith("done.myshopify.com", deps);
    const hb = schedulerHeartbeat();
    expect(hb.lastDataTickAt).not.toBeNull();
    expect(hb.dataTickRunning).toBe(false);
    expect(JSON.parse(hb.lastDataTick!)).toEqual(counts);
  });

  it("skips a tick while the previous one is still running", async () => {
    let release!: () => void;
    m.runBackfill.mockImplementationOnce(() => new Promise((r) => (release = () => r("done"))));
    const first = dataTick(deps);
    await vi.waitFor(() => expect(m.runBackfill).toHaveBeenCalled());
    expect(await dataTick(deps)).toEqual({ overlap: 1 });
    release();
    await first;
  });

  it("skips a shop whose install kickoff is still running", async () => {
    let release!: () => void;
    const busy = withShopLock("new.myshopify.com", () => new Promise<string>((r) => (release = () => r("x"))));
    const counts = await dataTick(deps);
    expect(counts.busy).toBe(1);
    release();
    await busy;
  });
});
