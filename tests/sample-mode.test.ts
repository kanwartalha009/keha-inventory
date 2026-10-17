/**
 * Sample data mode (owner 2026-10-17): "Explore with sample data" loads a simulated store under
 * `<shop>#sample` and never mixes it with the store's own rows; every screen reads the sample key
 * while it's on; store-changing actions are refused (I-1); "Switch to my store" and every shop
 * purge delete it; the scheduled jobs never see it; Sidekick answers from the real store only;
 * sample data shows at least Growth.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("./../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const { fakeRaw } = await import("./helpers/fake-raw");
  const db: FakeDb = createFakePrisma(
    {
      variantMetric: ["shop", "variantId", "scope"],
      moneyAtStake: ["shop", "day"],
      action: ["shop", "dedupeKey"],
      stockNow: ["shop", "variantId", "locationId"],
      sessionsDaily: ["shop", "day", "landingPath", "trafficType"],
      shopDaily: ["shop", "day"],
      shop: ["domain"],
    },
    ["variant", "supplier", "purchaseOrder", "stockNow", "action"],
    fakeRaw(() => db),
  );
  return { default: db.client, __fake: db };
});
const m = vi.hoisted(() => ({ shop: "real.myshopify.com", plan: "free" as string, graphql: [] as string[] }));
vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(async () => ({
      session: { shop: m.shop },
      admin: {
        graphql: async (q: string) => {
          m.graphql.push(q);
          return new Response(JSON.stringify({ data: {} }));
        },
      },
      cors: (r: Response) => r,
    })),
  },
  unauthenticated: { admin: vi.fn() },
}));
// The real entitlements, with the billing reads stubbed: the real store's plan is m.plan.
vi.mock("../app/services/billing.server", () => ({ getBillingState: vi.fn(async (shop: string) => (shop === m.shop ? { status: "ACTIVE", planCode: m.plan } : null)) }));
vi.mock("../app/services/plans.server", () => ({ getPlanOverride: vi.fn(async () => ({ type: "NONE", value: 0 })) }));
vi.mock("../app/services/app-pricing.server", () => ({ pricingConfigured: () => true, syncPlan: vi.fn(), syncPlanOnLoad: vi.fn() }));
vi.mock("../app/services/clearance.server", () => ({ createClearanceDiscount: vi.fn(async () => ({ ok: true, id: "gid://shopify/DiscountAutomaticNode/1" })) }));
vi.mock("../app/services/transfers.server", async (orig) => ({ ...(await orig<object>()), createTransfer: vi.fn(async () => ({ ok: true })) }));
vi.mock("../app/services/po-email.server", async (orig) => ({ ...(await orig<object>()), emailSupplier: vi.fn(async () => ({ ok: true, markedSent: true })) }));
vi.mock("../app/services/slack.server", async (orig) => ({ ...(await orig<object>()), deliverSlack: vi.fn(async () => ({ ok: true })) }));

import * as dbModule from "../app/db.server";
import { loadSampleData, removeSampleData } from "../app/services/sample-data.server";
import { dataScope } from "../app/services/data-scope.server";
import { getEntitlements } from "../app/services/entitlements.server";
import { purgeShopData } from "../app/services/gdpr.server";
import { runMondayEmailsAllShops } from "../app/services/monday.server";
import { runAlertsAllShops } from "../app/services/alerts.server";
import { createClearanceDiscount } from "../app/services/clearance.server";
import { createTransfer } from "../app/services/transfers.server";
import { emailSupplier } from "../app/services/po-email.server";
import { deliverSlack } from "../app/services/slack.server";
import { isSampleKey, offerSample, readSampleState, sampleIdPrefix, sampleIsStale, sampleKey, samplePlan, realShopOf } from "../app/lib/sample-mode-shared";
import { action as sampleAction } from "../app/routes/app.sample";
import { loader as homeLoader, action as homeAction, type HomeLoaderData } from "../app/routes/app._index";
import { loader as productsLoader, type ProductsData } from "../app/routes/app.products";
import { action as actionsAction } from "../app/routes/app.actions";
import { action as transfersAction } from "../app/routes/app.transfers";
import { action as orderAction } from "../app/routes/app.reorder_.$id";
import { action as alertsAction } from "../app/routes/app.settings_.alerts";
import { loader as sidekickLoader } from "../app/routes/api.sidekick.$tool";
import { loader as layoutLoader } from "../app/routes/app";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const REAL = "real.myshopify.com";
const KEY = `${REAL}#sample`;
const NOW = new Date("2026-10-19T07:00:00Z");

const req = (url: string, body?: unknown) =>
  new Request(`https://keha.test${url}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const rows = (table: string, shop: string) => (db.tables[table] ?? []).filter((r) => (table === "shop" ? r.domain : r.shop) === shop);
const json = async (r: unknown) => (r instanceof Response ? await r.json() : r);

/** The real store: installed yesterday, still reading (nothing ready). One real variant. */
function realStore() {
  db.reset();
  db.tables.shop = [
    {
      domain: REAL,
      currency: "EUR",
      timezone: "Europe/Madrid",
      locale: "en",
      settings: {},
      backfillState: { startedAt: "2026-10-18T10:00:00Z", datasets: { products: { done: 0, total: 1 } } },
      lastNightlyAt: null,
      uninstalledAt: null,
      installedAt: new Date("2026-10-18T10:00:00Z"),
      factDaysAt: null,
    },
  ];
  db.tables.variant = [
    { id: "gid://shopify/ProductVariant/4242", shop: REAL, productId: "gid://shopify/Product/42", productTitle: "My own shirt", variantTitle: "M", handle: "my-shirt", sku: "OWN-1", vendor: "Me", productType: null, collections: [], image: null, tracked: true, isBundle: false, status: "ACTIVE", productCreatedAt: null, cost: 5, costCurrency: "EUR", price: 20, supplierId: null, caseQty: null, noReorder: false, inventoryPolicy: "DENY", updatedAt: new Date() },
  ];
}

describe("sample-mode-shared", () => {
  it("keys, the plan shown, the state and the reserved id range", () => {
    expect(sampleKey(REAL)).toBe(KEY);
    expect(sampleKey(KEY)).toBe(KEY);
    expect(isSampleKey(KEY)).toBe(true);
    expect(isSampleKey(REAL)).toBe(false);
    expect(realShopOf(KEY)).toBe(REAL);
    expect(samplePlan("free")).toBe("growth");
    expect(samplePlan("none")).toBe("growth");
    expect(samplePlan("growth")).toBe("growth");
    expect(samplePlan("pro")).toBe("pro");
    expect(readSampleState({ sampleData: { on: true, loadedAt: "2026-10-19T07:00:00Z", idPrefix: "9912345678" } })).toEqual({ on: true, loadedAt: "2026-10-19T07:00:00Z", idPrefix: "9912345678" });
    expect(readSampleState({ sampleData: { on: "yes" } }).on).toBe(false);
    expect(readSampleState(null).on).toBe(false);
    expect(sampleIdPrefix(REAL)).toMatch(/^99\d{8}$/);
    expect(sampleIdPrefix(REAL, 1)).not.toBe(sampleIdPrefix(REAL, 0));
    const loaded = { on: true, loadedAt: "2026-10-15T07:00:00Z", idPrefix: null };
    expect(sampleIsStale(loaded, new Date("2026-10-17T07:00:00Z"))).toBe(false);
    expect(sampleIsStale(loaded, new Date("2026-10-19T07:00:01Z"))).toBe(true);
    expect(sampleIsStale({ ...loaded, on: false }, new Date("2026-10-30T07:00:00Z"))).toBe(false);
    expect(["syncing", "noSales", "noTracked"].every(offerSample)).toBe(true);
    expect(offerSample("ready")).toBe(false);
  });
});

describe("loading, reading and removing sample data", () => {
  beforeAll(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"], shouldAdvanceTime: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  beforeEach(() => {
    m.shop = REAL;
    m.plan = "free";
    m.graphql = [];
    realStore();
  });

  it("the Dashboard offers it while the store isn't ready; loading it never touches the store's own rows or Shopify", async () => {
    const before = (await homeLoader({ request: req("/app"), params: {}, context: {} } as never)) as HomeLoaderData;
    expect(before.state).not.toBe("ready");
    expect(before.sampleOffer).toBe(true);

    const own = JSON.stringify([db.tables.variant, db.tables.shop[0]!.backfillState]);
    const r = await json(await sampleAction({ request: req("/app/sample", { intent: "on" }), params: {}, context: {} } as never));
    expect(r).toEqual({ ok: true, on: true });
    // The simulated store lives under its own key, in the reserved id range.
    expect(rows("variant", KEY)).toHaveLength(300);
    expect(rows("shop", KEY)).toHaveLength(1);
    expect(rows("variantMetric", KEY).length).toBeGreaterThan(200);
    expect(rows("salesDaily", KEY).length).toBeGreaterThan(1000);
    for (const v of rows("variant", KEY)) expect(v.id as string).toMatch(/^gid:\/\/shopify\/ProductVariant\/99\d{15}$/);
    // The store's own rows are as they were, and no facts were written for it.
    expect(JSON.stringify([db.tables.variant!.filter((v) => v.shop === REAL), db.tables.shop.find((x) => x.domain === REAL)!.backfillState])).toBe(own);
    expect(rows("salesDaily", REAL)).toHaveLength(0);
    expect(m.graphql).toEqual([]); // loading it reads nothing from Shopify
    const state = readSampleState(db.tables.shop.find((x) => x.domain === REAL)!.settings);
    expect(state.on).toBe(true);
    expect(state.idPrefix).toMatch(/^99\d{8}$/);

    // Every screen now reads the sample key: the Dashboard is ready, nothing is "late", no review ask.
    expect((await dataScope(REAL)).shop).toBe(KEY);
    const after = (await homeLoader({ request: req("/app"), params: {}, context: {} } as never)) as HomeLoaderData;
    expect(after.state).toBe("ready");
    expect(after.sampleOffer).toBe(false);
    expect(after.dataLate).toBe(false);
    expect(after.reviewAsk ?? null).toBeNull();
    expect(after.orderPlan?.kind).toBe("full"); // Growth's features on sample data (the store is on Free)
    const products = (await productsLoader({ request: req("/app/products"), params: {}, context: {} } as never)) as ProductsData;
    expect(products.total).toBeGreaterThan(200);
    expect(products.rows.some((r) => r.productTitle === "My own shirt")).toBe(false);
    // The layout: the banner's facts (Free store → the plan note; the store isn't ready yet).
    const layout = (await layoutLoader({ request: req("/app"), params: {}, context: {} } as never)) as { plan: string; sample: { on: boolean; planLifted: boolean; realReady: boolean } };
    expect(layout.plan).toBe("growth");
    expect(layout.sample).toMatchObject({ on: true, planLifted: true, realReady: false });

    // "Switch to my store": every sample row goes, the store's own rows stay.
    const off = await json(await sampleAction({ request: req("/app/sample", { intent: "off" }), params: {}, context: {} } as never));
    expect(off).toEqual({ ok: true, on: false });
    for (const t of Object.keys(db.tables)) expect(rows(t, KEY), t).toHaveLength(0);
    expect(rows("variant", REAL)).toHaveLength(1);
    expect((await dataScope(REAL)).sample).toBe(false);
    // Shopify was only read (the admin language, as on every page), never written.
    expect(m.graphql.filter((q) => /mutation/i.test(q))).toEqual([]);
  }, 300_000);

  it("store-changing actions are refused on sample data (I-1); drafting orders works", async () => {
    await loadSampleData(REAL, NOW, { products: 30 });
    const clear = (db.tables.action ?? []).find((a) => a.shop === KEY);
    const r1 = await json(await actionsAction({ request: req("/app/actions", { op: "clear", id: clear?.id ?? "x", kind: "automatic", percent: "20", endsOn: "", code: "" }), params: {}, context: {} } as never));
    expect(r1).toEqual({ ok: false, error: "sample" });
    expect(createClearanceDiscount).not.toHaveBeenCalled();
    m.plan = "pro";
    const r2 = await json(await transfersAction({ request: req("/app/transfers", { originId: "gid://shopify/Location/1", destinationId: "gid://shopify/Location/2", quantities: {} }), params: {}, context: {} } as never));
    expect(r2).toEqual({ ok: false, error: "sample" });
    expect(createTransfer).not.toHaveBeenCalled();
    const po = rows("purchaseOrder", KEY).find((p) => p.status === "draft" && (p.lines as unknown[]).length > 0)!;
    for (const intent of ["email", "transition", "receive", "reopen"]) {
      const r = await json(await orderAction({ request: req(`/app/reorder/${po.id}`, { intent, to: "sent" }), params: { id: po.id as string }, context: {} } as never));
      expect(r, intent).toEqual({ ok: false, error: "sample" });
    }
    expect(emailSupplier).not.toHaveBeenCalled();
    const lines = (po.lines as { qty: number }[]).map((l) => l.qty + 1);
    const edit = await json(await orderAction({ request: req(`/app/reorder/${po.id}`, { intent: "edit", quantities: lines, version: (po.updatedAt as Date).toISOString() }), params: { id: po.id as string }, context: {} } as never));
    expect(edit).toEqual({ ok: true, intent: "edit" });
    // Alerts, Slack and the Monday email are the store's own: shown, never changed from sample data.
    const r3 = await json(await alertsAction({ request: req("/app/settings/alerts", { intent: "test" }), params: {}, context: {} } as never));
    expect(r3).toEqual({ ok: false, sample: true });
    expect(deliverSlack).not.toHaveBeenCalled();
    // No review is recorded from sample data.
    expect(await homeAction({ request: req("/app", { intent: "reviewAsked", code: "success" }), params: {}, context: {} } as never)).toEqual({ ok: false });
    expect(m.graphql.filter((q) => /mutation/i.test(q))).toEqual([]);
  }, 120_000);

  it("sample data shows at least Growth: Free → Growth, Pro stays Pro", async () => {
    m.plan = "free";
    expect((await getEntitlements(REAL)).plan).toBe("free");
    expect((await getEntitlements(KEY)).plan).toBe("growth");
    expect((await getEntitlements(KEY)).features.reorderPlan).toBe(true);
    m.plan = "pro";
    expect((await getEntitlements(KEY)).plan).toBe("pro");
  });

  it("the scheduled jobs (Monday email, alerts) never see sample data", async () => {
    await loadSampleData(REAL, NOW, { products: 12, compute: false });
    const listed: string[] = [];
    const real = db.client.shop as { findMany: (a: unknown) => Promise<{ domain: string }[]> };
    const findMany = real.findMany;
    real.findMany = async (a: unknown) => {
      const r = await findMany(a);
      listed.push(...r.map((x) => x.domain));
      return r;
    };
    try {
      await runMondayEmailsAllShops(NOW);
      await runAlertsAllShops(NOW);
    } finally {
      real.findMany = findMany;
    }
    expect(listed).toContain(REAL);
    expect(listed.some(isSampleKey)).toBe(false);
  }, 120_000);

  it("Sidekick answers from the store's own data only, never the sample", async () => {
    await loadSampleData(REAL, NOW, { products: 12 });
    expect((await dataScope(REAL)).sample).toBe(true);
    const res = (await sidekickLoader({ request: req("/api/sidekick/get_order_plan?within_days=7"), params: { tool: "get_order_plan" }, context: {} } as never)) as Response;
    const body = (await res.json()) as { results?: unknown[]; message?: string };
    // The real store is still being read: no order lines (the sample store has dozens).
    expect(body.results ?? []).toEqual([]);
    expect(body.message).toBeTruthy();
    const sampleTitles = rows("variant", KEY).map((v) => v.productTitle as string);
    expect(sampleTitles.some((t) => JSON.stringify(body).includes(t))).toBe(false);
  }, 120_000);

  it("shop/redact and the uninstall purge delete the sample data too", async () => {
    await loadSampleData(REAL, NOW, { products: 12, compute: false });
    expect(rows("variant", KEY).length).toBeGreaterThan(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const counts = await purgeShopData(REAL);
    expect(counts["sample:variant"]).toBeGreaterThan(0);
    for (const t of Object.keys(db.tables)) {
      expect(rows(t, KEY), t).toHaveLength(0);
      expect(rows(t, REAL), t).toHaveLength(0);
    }
  }, 120_000);

  it("another store's sample ids are never written over (each store gets a free id range)", async () => {
    await loadSampleData(REAL, NOW, { products: 6, compute: false });
    const taken = rows("variant", KEY).map((v) => v.id as string);
    // A second store whose first prefix is taken (forced) gets the next one.
    const OTHER = "other.myshopify.com";
    db.tables.shop.push({ ...db.tables.shop.find((x) => x.domain === REAL)!, domain: OTHER, settings: {} });
    const first = sampleIdPrefix(OTHER, 0);
    db.tables.variant!.push({ ...rows("variant", KEY)[0]!, id: `gid://shopify/ProductVariant/${first}0000001`, shop: "someone-else#sample" });
    await loadSampleData(OTHER, NOW, { products: 6, compute: false });
    const state = readSampleState(db.tables.shop.find((x) => x.domain === OTHER)!.settings);
    expect(state.idPrefix).toBe(sampleIdPrefix(OTHER, 1));
    expect(rows("variant", KEY).map((v) => v.id)).toEqual(taken);
  }, 120_000);
});
