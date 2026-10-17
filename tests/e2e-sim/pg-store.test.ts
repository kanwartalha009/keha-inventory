/**
 * End-to-end simulation on real Postgres (skipped where none is reachable, tests/helpers/pg): an S
 * store (60 products / 300 variants) and an M store (600 / 3,000) written through the sync's own
 * writers into a fresh database with every migration, the real compute and every screen's real
 * loader running real SQL (tests/helpers/pg-prisma) — and the same business invariants as the
 * in-memory run (harness checkInvariants). The two stores share the database (different shop
 * keys), as stores do in production.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PG_AVAILABLE, dropDb, freshDb } from "../helpers/pg";

const DB = "r2_sample_e2e";
vi.mock("../../app/db.server", async () => {
  const { createPgPrisma } = await import("../helpers/pg-prisma");
  return { default: createPgPrisma("r2_sample_e2e") };
});
vi.mock("../../app/shopify.server", async () => (await import("./mocks")).shopifyMock());
vi.mock("../../app/services/entitlements.server", async () => (await import("./mocks")).entitlementsMock());
vi.mock("../../app/services/email.server", async (orig) => ({ ...(await orig<object>()), ...(await import("./mocks")).emailMock() }));
vi.mock("../../app/services/keha-preorder.server", async (orig) => ({ ...(await orig<object>()), kehaPreorderInstalled: async () => false }));

import prisma from "../../app/db.server";
import { E2E_NOW, checkInvariants, collectScreens, expectTranslated, loadSimStore, renderScreens } from "./harness";

process.env.SHOPIFY_APP_URL = "https://keha.test";
process.env.SHOPIFY_API_SECRET = "e2e-sim-secret";

describe.skipIf(!PG_AVAILABLE)("simulated stores on real Postgres", () => {
  beforeAll(() => {
    freshDb(DB);
    vi.useFakeTimers({ now: E2E_NOW, toFake: ["Date"], shouldAdvanceTime: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(async () => {
    vi.useRealTimers();
    await (prisma as unknown as { $close: () => Promise<void> }).$close();
    dropDb(DB);
  });

  for (const [size, key] of [
    ["S", "sim-s.myshopify.com"],
    ["M", "sim-m.myshopify.com"],
  ] as const) {
    it(`${size}: written by the sync's writers, computed, every screen holds the invariants and renders in en + de`, async () => {
      const loaded = await loadSimStore(key, size);
      expect(loaded.compute.status).toBe("computed");
      expect(loaded.report.variants).toBe(size === "S" ? 300 : 3000);
      const screens = await collectScreens(key, loaded.store);
      const counts = await checkInvariants(loaded, screens);
      for (const locale of ["en", "de"] as const) {
        const html = renderScreens(screens.screens, locale);
        expectTranslated(html.get("dashboard")!, locale, ["Order this week", "Money at stake"]);
      }
      console.info(`[e2e-sim] ${size} postgres: ${JSON.stringify(counts)} (write ${loaded.ms.write} ms, compute ${loaded.ms.compute} ms)`);
    }, 1_800_000);
  }
});
