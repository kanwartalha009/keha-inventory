/**
 * End-to-end simulation on the in-memory database (always runs): a simulated small store (S: 60
 * products, 300 variants, 14 months) written through the sync's own writers, the real compute,
 * every screen's real loader, the Monday email and Sidekick — and the business invariants
 * (tests/e2e-sim/harness checkInvariants). Every screen renders in English and German.
 * The same harness runs on real Postgres in pg-store.test.ts (S and M).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "../helpers/fake-prisma";

vi.mock("../../app/db.server", async () => {
  const { createFakePrisma } = await import("../helpers/fake-prisma");
  const { fakeRaw } = await import("../helpers/fake-raw");
  const db: FakeDb = createFakePrisma(
    {
      variantMetric: ["shop", "variantId", "scope"],
      moneyAtStake: ["shop", "day"],
      action: ["shop", "dedupeKey"],
      stockNow: ["shop", "variantId", "locationId"],
      sessionsDaily: ["shop", "day", "landingPath", "trafficType"],
      shopDaily: ["shop", "day"],
      shop: ["domain"],
      ownerEmailLog: ["shop", "kind", "periodKey"],
    },
    ["variant", "supplier", "purchaseOrder", "stockNow", "action"],
    fakeRaw(() => db),
  );
  return { default: db.client, __fake: db };
});
vi.mock("../../app/shopify.server", async () => (await import("./mocks")).shopifyMock());
vi.mock("../../app/services/entitlements.server", async () => (await import("./mocks")).entitlementsMock());
vi.mock("../../app/services/email.server", async (orig) => ({ ...(await orig<object>()), ...(await import("./mocks")).emailMock() }));
vi.mock("../../app/services/keha-preorder.server", async (orig) => ({ ...(await orig<object>()), kehaPreorderInstalled: async () => false }));

import { E2E_NOW, checkInvariants, collectScreens, expectTranslated, loadSimStore, renderScreens, type Loaded, type Screens } from "./harness";
import * as dbModule from "../../app/db.server";
import { useFakeFacts } from "../helpers/fake-facts";

// The compact facts and the catalog's bulk writes over the in-memory tables (R1's facts store API).
useFakeFacts((dbModule as unknown as { __fake: FakeDb }).__fake);

process.env.SHOPIFY_APP_URL = "https://keha.test";
process.env.SHOPIFY_API_SECRET = "e2e-sim-secret";

const KEY = "sim-s.myshopify.com";
let loaded: Loaded;
let screens: Screens;

beforeAll(async () => {
  // The clock starts at E2E_NOW and runs (a frozen Date stalls vitest's own reporting).
  vi.useFakeTimers({ now: E2E_NOW, toFake: ["Date"], shouldAdvanceTime: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  loaded = await loadSimStore(KEY, "S");
  screens = await collectScreens(KEY, loaded.store);
}, 300_000);

afterAll(() => {
  vi.useRealTimers();
});

describe("simulated S store, in-memory database", () => {
  it("is written by the sync's writers and computed", () => {
    expect(loaded.report.variants).toBe(300);
    expect(loaded.report.facts.stock).toBeGreaterThan(100_000);
    expect(loaded.compute.status).toBe("computed");
    expect(loaded.compute.money).toBe("computed");
    expect(loaded.compute.actions).toBeGreaterThan(0);
  });

  it("holds the business invariants across every screen, the email and Sidekick", async () => {
    const counts = await checkInvariants(loaded, screens);
    console.info(`[e2e-sim] S fake: ${JSON.stringify(counts)} (write ${loaded.ms.write} ms, compute ${loaded.ms.compute} ms)`);
  }, 120_000);

  it("every screen renders on the server in English and German", () => {
    for (const locale of ["en", "de"] as const) {
      const html = renderScreens(screens.screens, locale);
      expectTranslated(html.get("dashboard")!, locale, ["Due this week", "Money at stake"]);
      expectTranslated(html.get("order-now")!, locale, ["Order plan"]);
      expectTranslated(html.get("products")!, locale, ["Products"]);
      expect(html.size).toBe(screens.screens.length);
    }
  });
});
