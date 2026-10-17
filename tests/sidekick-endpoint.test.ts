/**
 * GET /api/sidekick/:tool (app/routes/api.sidekick.$tool.tsx) and
 * app/services/sidekick.server.ts on a fake database:
 *  - CORS: our responses carry the headers; the library answers the OPTIONS preflight
 *    for the sandbox origin (https://extensions.shopifycdn.com) with 204 + `*`;
 *  - every tool answers from the database only (the Admin API client is never used);
 *  - plan gating exactly as the screens: Free gets no order plan / purchase orders /
 *    accuracy, no forecast fields, the top 10 actions without Fix rows — and no
 *    plan or upgrade words anywhere; a failed plan check fails open;
 *  - an empty store gets the neutral "still reading" message; unknown tools 404;
 *    a failing tool answers 500 with a neutral message; a slow one is cut off.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStaticHandler } from "react-router";
import type { FakeDb } from "./helpers/fake-prisma";
import { homeBasis } from "./home-fixtures";
import { policyViolations } from "./helpers/sidekick-policy";
import { featureMap, type PlanCode } from "../app/lib/plan-shared";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma();
  return { default: db.client, __fake: db };
});
const m = vi.hoisted(() => ({
  shop: "acme.myshopify.com",
  graphql: vi.fn(),
  plan: "growth" as string,
  entitlementsFail: false,
}));
vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(async (request: Request) => {
      // The library's own behaviour for the preflight (pinned in the last describe below).
      if (request.method === "OPTIONS") throw new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
      return {
        admin: { graphql: m.graphql },
        session: { shop: m.shop },
        cors: (r: Response) => {
          r.headers.set("Access-Control-Allow-Origin", "*");
          r.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
          return r;
        },
      };
    }),
  },
}));
vi.mock("../app/services/entitlements.server", () => ({
  getEntitlements: vi.fn(async () => {
    if (m.entitlementsFail) throw new Error("billing table unreachable");
    return { plan: m.plan, features: featureMap(m.plan as PlanCode), comped: false, checked: true };
  }),
}));

import * as dbModule from "../app/db.server";
import { loader, withDeadline } from "../app/routes/api.sidekick.$tool";
import { SIDEKICK_TOOLS, MSG } from "../app/lib/sidekick-shared";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const SHOP = "acme.myshopify.com";
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const P = (n: number) => `gid://shopify/Product/${n}`;
const L1 = "gid://shopify/Location/1";
const NOW = new Date("2026-10-17T10:00:00Z");
const day = (s: string) => new Date(`${s}T00:00:00Z`);

async function get(tool: string, query = "", method = "GET") {
  const request = new Request(`https://inventory.keha.io/api/sidekick/${tool}${query ? `?${query}` : ""}`, {
    method,
    headers: { Origin: "https://extensions.shopifycdn.com", Authorization: "Bearer token" },
  });
  try {
    return (await loader({ request, params: { tool }, context: {} } as never)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}
async function body(tool: string, query = "") {
  const res = await get(tool, query);
  expect(res.status, tool).toBe(200);
  return (await res.json()) as Record<string, unknown> & { results?: { name: string; uri: string; _meta: Record<string, unknown> }[]; message?: string; note?: string };
}

function seed() {
  db.reset();
  db.tables.shop = [
    {
      domain: SHOP,
      currency: "EUR",
      timezone: "Europe/Madrid",
      locale: "en",
      settings: {},
      backfillState: { finishedAt: "2026-10-10T00:00:00Z", first90Ready: true },
      lastNightlyAt: new Date("2026-10-17T02:10:00Z"),
    },
  ];
  db.tables.location = [{ id: L1, shop: SHOP, active: true, online: true, onlinePool: null }];
  db.tables.supplier = [
    { id: "s1", shop: SHOP, name: "Acme Textiles", email: "orders@acme.test", leadTimeDays: 21, minOrder: null, minOrderTotal: null, casePack: null, vendorMatch: [], currency: "EUR", hidePrices: false },
  ];
  const variant = (n: number, product: number, title: string, vt: string, extra: Record<string, unknown> = {}) => ({
    id: V(n), shop: SHOP, productId: P(product), productTitle: title, variantTitle: vt, handle: "h", sku: `SKU-${n}`, vendor: "Acme", productType: null,
    collections: [], image: null, tracked: true, isBundle: false, status: "ACTIVE", supplierId: "s1", caseQty: null, cost: 10, costCurrency: null, price: 40, ...extra,
  });
  db.tables.variant = [
    variant(1, 1, "Hoodie", "Blue / M"),
    variant(2, 1, "Hoodie", "Red / M", { cost: null }),
    variant(3, 3, "Cap", "Default Title", { supplierId: null, vendor: "CapCo", cost: 5 }),
    variant(4, 4, "Untracked mug", "Default Title", { tracked: false }),
  ];
  const metric = (n: number, extra: Record<string, unknown>) => ({
    shop: SHOP, variantId: V(n), scope: "online", rate: null, sigma: null, daysLeft: null, neverRunsOut: false, status: "healthy", role: "A",
    orderQty: 0, orderBy: null, computedAt: NOW, inputs: {}, ...extra,
  });
  db.tables.variantMetric = [
    metric(1, { status: "running_low", rate: 2, daysLeft: 5.5, orderQty: 30, orderBy: day("2026-10-20") }),
    metric(2, { status: "out", rate: 1, daysLeft: 0, orderQty: 10, orderBy: day("2026-10-12") }),
    metric(3, { status: "dead", rate: 0, neverRunsOut: true }),
  ];
  db.tables.stockNow = [
    { shop: SHOP, variantId: V(1), locationId: L1, onHand: 11, incoming: 0 },
    { shop: SHOP, variantId: V(2), locationId: L1, onHand: 0, incoming: 5 },
    { shop: SHOP, variantId: V(3), locationId: L1, onHand: 50, incoming: 0 },
  ];
  db.tables.purchaseOrder = [
    { id: "po1", shop: SHOP, source: "keha", status: "sent", number: "PO-0001", supplierId: "s1", supplierName: "Acme Textiles", currency: "EUR", lines: [{ variantId: V(1), qty: 20, unitCost: 10 }], confirmedShipDate: null, expectedDate: day("2026-11-01"), createdAt: new Date("2026-10-01T09:00:00Z") },
    { id: "po2", shop: SHOP, source: "shopify", status: "sent", number: "#PO-7", supplierId: null, supplierName: null, currency: null, lines: [{ variantId: V(2), qty: 5 }], confirmedShipDate: null, expectedDate: null, createdAt: new Date("2026-10-05T09:00:00Z") },
    { id: "po3", shop: SHOP, source: "keha", status: "received", number: "PO-0000", supplierId: "s1", supplierName: "Acme Textiles", currency: "EUR", lines: [{ variantId: V(1), qty: 5 }], confirmedShipDate: null, expectedDate: null, createdAt: new Date("2026-09-01T09:00:00Z") },
    { id: "px", shop: "other.myshopify.com", source: "keha", status: "sent", number: "PO-0009", supplierId: null, supplierName: "Other", currency: "EUR", lines: [], confirmedShipDate: null, expectedDate: null, createdAt: new Date("2026-10-01T09:00:00Z") },
  ];
  const action = (id: string, kind: string, product: number, amount: number, reason: unknown) => ({
    id, shop: SHOP, kind, productId: P(product), variantIds: [V(product)], amount, currency: "EUR", reason, state: "open", snoozeUntil: null, stateAmount: null, doneAt: null,
  });
  db.tables.action = [
    action("a1", "reorder", 1, 300, { key: "reorder_low", params: { days: 5, lead: 21, date: "2026-10-20" } }),
    action("a2", "clear", 3, 250, { key: "clear_dead", params: { days: 120, units: 50 } }),
    action("a3", "fix_sizes", 1, 500, { key: "fix_sizes", params: { out: 1, total: 2 } }),
    ...Array.from({ length: 11 }, (_, i) => action(`f${i}`, "push", 100 + i, 50 - i, { key: "push_steady", params: {} })),
  ];
  db.tables.clearance = [];
  db.tables.moneyAtStake = [{ shop: SHOP, day: day("2026-10-16"), atRisk: 1234.5, lost90: null, cashStuck: 800, soldOutTraffic: 42, basis: homeBasis() }];
  db.tables.salesDaily = Array.from({ length: 14 }, (_, i) => ({ shop: SHOP, day: day(`2026-10-${String(i + 1).padStart(2, "0")}`), variantId: V(1), locationKey: "all", channel: "web", sold: 2 }));
  db.tables.accuracyMonth = [
    { shop: SHOP, month: day("2026-09-01"), storeErrorPct: 11.84, top20ErrorPct: 19.2, graded: 20 },
    { shop: SHOP, month: day("2026-08-01"), storeErrorPct: null, top20ErrorPct: null, graded: 0 },
  ];
}

const bodies: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  m.plan = "growth";
  m.entitlementsFail = false;
  m.graphql.mockReset();
  seed();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("route", () => {
  it("answers every tool with CORS headers, no caching, and no Admin API call", async () => {
    for (const tool of SIDEKICK_TOOLS) {
      const res = await get(tool, tool === "get_product_stock" ? "query=hoodie" : "");
      expect(res.status, tool).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin"), tool).toBe("*");
      expect(res.headers.get("Cache-Control"), tool).toBe("no-store");
      const text = await res.text();
      bodies.push(text);
      expect(text.length, tool).toBeLessThanOrEqual(14_000);
    }
    expect(m.graphql).not.toHaveBeenCalled();
  });

  it("lets the preflight through authenticate.admin's answer", async () => {
    const res = await get("get_order_plan", "", "OPTIONS");
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("React Router hands the preflight (OPTIONS) of this resource route to its loader", async () => {
    const handler = createStaticHandler([{ id: "sidekick", path: "/api/sidekick/:tool", loader }]);
    const res = await handler
      .queryRoute(new Request("https://inventory.keha.io/api/sidekick/get_order_plan", { method: "OPTIONS", headers: { Origin: "https://extensions.shopifycdn.com" } }))
      .catch((e: unknown) => e);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(204);
  });

  it("404s an unknown tool, with CORS", async () => {
    const res = await get("delete_products");
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("answers 500 with a neutral message when a tool fails", async () => {
    const accuracy = db.client.accuracyMonth as { findMany: (...a: unknown[]) => Promise<unknown> };
    const original = accuracy.findMany;
    accuracy.findMany = async () => {
      throw new Error("connection reset");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await get("get_forecast_accuracy");
      expect(res.status).toBe(500);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(await res.json()).toEqual({ message: MSG.failed });
      expect(JSON.stringify(spy.mock.calls)).not.toContain("connection reset");
    } finally {
      accuracy.findMany = original;
      spy.mockRestore();
    }
  });

  it("cuts a slow answer off before Sidekick's 1-second limit", async () => {
    vi.useRealTimers();
    expect(await withDeadline(new Promise(() => {}), 10)).toEqual({ message: MSG.slow });
    expect(await withDeadline(Promise.resolve({ message: "ok" }), 10)).toEqual({ message: "ok" });
  });
});

describe("tools on Growth", () => {
  it("get_order_plan: the Reorder groups, net of open Keha orders, with order-by dates and cash", async () => {
    const r = await body("get_order_plan", "within_days=14");
    expect(r.results!.map((x) => x.name)).toEqual(["Acme Textiles"]);
    const meta = r.results![0]!._meta as { lines: { variant_gid: string; order_qty: number; order_by: string }[] } & Record<string, unknown>;
    // V1: 30 suggested − 20 already on the sent Keha order = 10; V2 (no cost) 10.
    expect(meta.lines.map((l) => [l.variant_gid, l.order_qty, l.order_by])).toEqual([
      [V(2), 10, "2026-10-12"],
      [V(1), 10, "2026-10-20"],
    ]);
    expect(meta).toMatchObject({ order_by: "2026-10-12", order_by_label: "Mon 12 Oct 2026 (5 days ago)", lead_time_days: 21, units: 20, cost: 100, lines_without_cost: 1, currency: "EUR" });
    expect(r.totals).toEqual({ suppliers: 1, units: 20, cash: [{ currency: "EUR", amount: 100, lines_without_cost: 1 }] });
    expect(r.order_by_until).toBe("2026-10-31");
    expect((await body("get_order_plan", "supplier=nobody")).message).toBe(MSG.noSupplierMatch);
  });

  it("get_product_stock: matches every word in any order, any case, with the app's status words", async () => {
    const r = await body("get_product_stock", "query=blue%20HOODIE");
    expect(r.results!.map((x) => x.name)).toEqual(["Hoodie — Blue / M"]);
    expect(r.results![0]!._meta).toMatchObject({
      status: "Running low",
      on_hand: 11,
      incoming: 0,
      on_order_with_keha: 20,
      keha_order_arrival: "2026-11-01",
      sales_per_day: 2,
      days_left: 5,
      order_by: "2026-10-20",
      suggested_order_qty: 30,
      url: "app://app/products/1",
    });
    expect((await body("get_product_stock", "query=sku-3")).results!.map((x) => x.name)).toEqual(["Cap"]);
    expect((await body("get_product_stock", "query=mug")).message).toBe(MSG.noProducts);
    expect((await body("get_product_stock")).message).toBe(MSG.emptyQuery);
  });

  it("get_action_list: every action, ranked, with the reason sentence; kind filter", async () => {
    const r = await body("get_action_list");
    expect(r.results).toHaveLength(14);
    expect(r.results![0]!._meta).toMatchObject({ action: "Fix: missing sizes", money_at_stake: 500 });
    expect(r.results![1]!._meta).toMatchObject({
      action: "Reorder",
      why: "Runs out in 5 days; a new order takes 21 days to arrive. Order by 20 Oct.",
      url: "app://app/reorder?variants=gid%3A%2F%2Fshopify%2FProductVariant%2F1",
    });
    expect(r.note).toBeUndefined();
    const clear = await body("get_action_list", "kind=clear");
    expect(clear.results!.map((x) => x.name)).toEqual(["Cap"]);
  });

  it("get_money_at_stake: the four cards with how we got this, plus dead stock", async () => {
    const r = await body("get_money_at_stake");
    expect(r).toMatchObject({ as_of: "2026-10-16", currency: "EUR", refreshed: "daily" });
    const cards = r.cards as { name: string; amount: number | null; how_we_got_this: string | null }[];
    expect(cards.map((c) => [c.name, c.amount])).toEqual([
      ["Sales at risk (next 28 days)", 1234.5],
      ["Sales lost to sell-outs (last 90 days)", null],
      ["Cash stuck (too much stock and dead stock)", 800],
      ["Sold-out page visits (last 30 days)", 42],
    ]);
    expect(cards[0]!.how_we_got_this).toContain("Based on: sales per day while in stock");
    expect(r.dead_stock).toMatchObject({ amount: 250, units: 50, variants: 1, valued_at: "cost" });
  });

  it("get_purchase_orders: open Keha and Shopify orders of this store only, soonest first", async () => {
    const r = await body("get_purchase_orders");
    expect(r.results!.map((x) => [x.name, x._meta.status, x._meta.expected_arrival])).toEqual([
      ["PO-0001 — Acme Textiles", "Sent", "2026-11-01"],
      ["#PO-7", "Ordered", null],
    ]);
    expect(r.results![0]!._meta).toMatchObject({ units: 20, value: 200, currency: "EUR", url: "app://app/reorder/po1" });
    expect((await body("get_purchase_orders", "status=draft")).message).toBe(MSG.noOrders);
  });

  it("get_forecast_accuracy: graded months, newest first", async () => {
    const r = await body("get_forecast_accuracy", "months=2");
    expect(r.months).toEqual([
      { month: "2026-09", store_total_error_pct: 11.8, top_20_products_error_pct: 19.2, variants_graded: 20 },
      { month: "2026-08", store_total_error_pct: null, top_20_products_error_pct: null, variants_graded: 0 },
    ]);
  });
});

describe("plans", () => {
  it("Free: only what the Free screens show, and not one plan or upgrade word", async () => {
    m.plan = "free";
    for (const tool of ["get_order_plan", "get_purchase_orders"]) expect((await body(tool)).message, tool).toBe(MSG.notAvailable);
    expect((await body("get_forecast_accuracy")).message).toBe(MSG.notAvailable);
    const stock = await body("get_product_stock", "query=hoodie");
    for (const row of stock.results!) {
      for (const k of ["days_left", "order_by", "suggested_order_qty"]) expect(row._meta).not.toHaveProperty(k);
      expect(row._meta).toHaveProperty("status");
    }
    const actions = await body("get_action_list");
    expect(actions.results).toHaveLength(10);
    expect(actions.results!.some((x) => String(x._meta.action).startsWith("Fix"))).toBe(false);
    expect(actions.note).toBe("Ranked by money at stake; the list covers the 10 largest actions.");
    expect((await body("get_money_at_stake")).refreshed).toBe("monthly");
    for (const tool of SIDEKICK_TOOLS) {
      const text = await (await get(tool, "query=hoodie")).text();
      expect(policyViolations(text), tool).toEqual([]);
      expect(text, tool).not.toMatch(/\b(Free|Growth|Pro)\b/);
    }
  });

  it("fails open when the plan check fails", async () => {
    m.entitlementsFail = true;
    expect((await body("get_order_plan")).results!.length).toBe(1);
    expect((await body("get_forecast_accuracy")).months).toBeDefined();
  });

  it("no Growth response breaks the content policy", () => {
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.flatMap(policyViolations)).toEqual([]);
  });
});

describe("empty store", () => {
  it("says the data is still being read, for every tool that needs the store", async () => {
    db.reset();
    for (const tool of ["get_order_plan", "get_product_stock", "get_action_list", "get_money_at_stake", "get_purchase_orders"]) {
      const r = await body(tool, "query=hoodie");
      expect(r.message, tool).toBe(MSG.syncing);
      expect(r.results ?? [], tool).toEqual([]);
    }
    expect((await body("get_forecast_accuracy")).message).toBe(MSG.noAccuracy);
  });

  it("not enough sales yet: the Home message", async () => {
    db.tables.salesDaily = db.tables.salesDaily!.slice(0, 5);
    expect((await body("get_money_at_stake")).message).toBe(MSG.noSales);
    expect((await body("get_action_list")).message).toBe(MSG.noSales);
  });
});

describe("@shopify/shopify-app-react-router CORS (pinned: the Sidekick sandbox depends on it)", () => {
  const params = { logger: { debug() {} }, config: { appUrl: "https://inventory.keha.io" } };
  /** The installed library's own helper (not exported by the package, so loaded by file). */
  const libHelper = (file: string): Promise<unknown> =>
    import(
      /* @vite-ignore */ pathToFileURL(
        join(__dirname, "../node_modules/@shopify/shopify-app-react-router/dist/esm/server/authenticate/helpers", file),
      ).href
    );
  const req = (method: string) =>
    new Request("https://inventory.keha.io/api/sidekick/get_order_plan", { method, headers: { Origin: "https://extensions.shopifycdn.com" } });

  it("answers OPTIONS with 204 and allows the sandbox origin and the Authorization header", async () => {
    const { respondToOptionsRequest } = (await libHelper("respond-to-options-request.mjs")) as {
      respondToOptionsRequest: (p: unknown, r: Request) => void;
    };
    let thrown: unknown;
    try {
      respondToOptionsRequest(params, req("OPTIONS"));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(() => respondToOptionsRequest(params, req("GET"))).not.toThrow();
  });

  it("cors() adds the headers for a cross-origin GET", async () => {
    const { ensureCORSHeadersFactory } = (await libHelper("ensure-cors-headers.mjs")) as {
      ensureCORSHeadersFactory: (p: unknown, r: Request) => (res: Response) => Response;
    };
    const res = ensureCORSHeadersFactory(params, req("GET"))(new Response("{}"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
