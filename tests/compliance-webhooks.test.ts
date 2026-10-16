/**
 * Mandatory compliance webhooks (App Store submission; shopify.dev
 * /docs/apps/build/compliance/privacy-law-compliance): each of customers/data_request,
 * customers/redact and shop/redact must answer 401 to a bad HMAC and 2xx to a valid one.
 *
 * The routes run against a REAL `shopifyApp` (only the secret is a test value), so this
 * proves the library's HMAC check sits in front of every handler; the data work behind it
 * is mocked here and covered in gdpr.test.ts.
 */
import "@shopify/shopify-app-react-router/adapters/node";
import { createHmac } from "node:crypto";
import { ApiVersion, AppDistribution, shopifyApp } from "@shopify/shopify-app-react-router/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-secret-not-real";

const m = vi.hoisted(() => ({
  forward: vi.fn(async () => undefined),
  deliverDataRequest: vi.fn(async () => undefined),
  redactCustomer: vi.fn(async () => ({ outboxDeleted: 0 })),
  purgeShopData: vi.fn(async () => ({})),
}));

vi.mock("../app/shopify.server", () => {
  const sessions = {
    storeSession: async () => true,
    loadSession: async () => undefined,
    deleteSession: async () => true,
    deleteSessions: async () => true,
    findSessionsByShop: async () => [],
  };
  const app = shopifyApp({
    apiKey: "test-key",
    apiSecretKey: SECRET,
    apiVersion: ApiVersion.October26,
    scopes: ["read_products"],
    appUrl: "https://inventory.example.test",
    authPathPrefix: "/auth",
    distribution: AppDistribution.AppStore,
    sessionStorage: sessions as never,
  });
  return { authenticate: app.authenticate };
});
vi.mock("../app/lib/nova.server", () => ({ forwardToIngress: m.forward }));
vi.mock("../app/services/gdpr.server", () => ({
  deliverDataRequest: m.deliverDataRequest,
  redactCustomer: m.redactCustomer,
  purgeShopData: m.purgeShopData,
}));
vi.mock("../app/db.server", () => ({ default: { uninstalledShop: { deleteMany: async () => ({ count: 0 }) } } }));

const SHOP = "keha-test.myshopify.com";

function request(topic: string, body: object, hmac?: string): Request {
  const raw = JSON.stringify(body);
  return new Request(`https://inventory.example.test/webhooks/${topic}`, {
    method: "POST",
    body: raw,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": hmac ?? createHmac("sha256", SECRET).update(raw).digest("base64"),
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": SHOP,
      "X-Shopify-API-Version": "2026-10",
      "X-Shopify-Webhook-Id": `wh-${topic}`,
      "X-Shopify-Event-Id": `ev-${topic}`,
      "X-Shopify-Triggered-At": new Date().toISOString(),
    },
  });
}

async function status(run: () => Promise<Response>): Promise<number> {
  try {
    return (await run()).status;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

const ROUTES = [
  {
    topic: "customers/data_request",
    load: () => import("../app/routes/webhooks.customers.data_request"),
    body: { shop_domain: SHOP, customer: { id: 1, email: "a@example.com" }, orders_requested: [], data_request: { id: 9 } },
    work: () => m.deliverDataRequest,
  },
  {
    topic: "customers/redact",
    load: () => import("../app/routes/webhooks.customers.redact"),
    body: { shop_domain: SHOP, customer: { id: 1, email: "a@example.com" }, orders_to_redact: [] },
    work: () => m.redactCustomer,
  },
  {
    topic: "shop/redact",
    load: () => import("../app/routes/webhooks.shop.redact"),
    body: { shop_domain: SHOP, shop_id: 1 },
    work: () => m.purgeShopData,
  },
];

describe("mandatory compliance webhooks verify the HMAC", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const r of ROUTES) {
    it(`${r.topic}: bad HMAC → 401 and nothing runs`, async () => {
      const { action } = await r.load();
      const req = request(r.topic, r.body, "bm90LXRoZS1yaWdodC1obWFj");
      expect(await status(() => action({ request: req, params: {}, context: {} } as never))).toBe(401);
      expect(r.work()).not.toHaveBeenCalled();
      expect(m.forward).not.toHaveBeenCalled();
    });

    it(`${r.topic}: valid HMAC → 200 and the handler runs`, async () => {
      const { action } = await r.load();
      const req = request(r.topic, r.body);
      expect(await status(() => action({ request: req, params: {}, context: {} } as never))).toBe(200);
      expect(r.work()).toHaveBeenCalledTimes(1);
    });
  }
});
