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
import { loader as reorderLoader, type ReorderPageData } from "../app/routes/app.reorder";
import { loader as calendarLoader, type CalendarPageData } from "../app/routes/app.reorder_.calendar";
import { planWeeks } from "../app/lib/order-plan-shared";
import { bySupplier, cashTotals } from "../app/lib/engine/forward-plan-shared";
import { safetyStock } from "../app/lib/engine/order-shared";

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
  /** VariantMetric.inputs as compute writes them; orderNeed = demand(lead + cycle) + safety − stock. */
  const plannedInputs = (rate: number, onHand: number, incoming: number) => {
    const safety = safetyStock(1.28, 1, 21);
    return { today: "2026-10-17", seasonal: 1, trend: 1, plan: 1, leadTimeDays: 21, cycleDays: 14, z: 1.28, safety, onHand, incoming, orderNeed: rate * 35 + safety - onHand - incoming, kehaOnOrder: 0, arrivals: [], seasonCurve: null };
  };
  const metric = (n: number, extra: Record<string, unknown>) => ({
    shop: SHOP, variantId: V(n), scope: "online", rate: null, sigma: null, daysLeft: null, neverRunsOut: false, status: "healthy", role: "A",
    orderQty: 0, orderBy: null, computedAt: NOW, inputs: {}, ...extra,
  });
  db.tables.variantMetric = [
    // As compute stores them (forward plan inputs): lead 21, cycle 14, z 1.28, σ 1.
    metric(1, { status: "running_low", rate: 2, sigma: 1, daysLeft: 5.5, orderQty: 65, orderBy: day("2026-10-12"), inputs: plannedInputs(2, 11, 0) }),
    metric(2, { status: "out", rate: 1, sigma: 1, daysLeft: 0, orderQty: 36, orderBy: day("2026-09-30"), inputs: plannedInputs(1, 0, 5) }),
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
  it("get_order_plan: the same orders, quantities, dates and cash as Order now and Next 13 weeks", async () => {
    const orderNow = (await reorderLoader({ request: new Request("https://inventory.keha.io/app/reorder"), params: {}, context: {} } as never)) as ReorderPageData;
    const calendar = (await calendarLoader({ request: new Request("https://inventory.keha.io/app/reorder/calendar"), params: {}, context: {} } as never)) as CalendarPageData;
    expect(calendar.enabled).toBe(true);
    type Line = { variant_gid: string; order_qty: number; order_by: string; arrives: string; cost: number | null };
    const linesOf = (r: Awaited<ReturnType<typeof body>>) =>
      r.results!.flatMap((g) => (g._meta.lines as Line[]).map((l) => [g.name, l.variant_gid, l.order_qty, l.arrives, l.cost] as const)).sort();

    // Next 13 weeks (within_days 90) = the calendar loader: every order, by supplier, same totals and weeks.
    const all = await body("get_order_plan", "within_days=90");
    const events = calendar.plan.events;
    expect(events.length).toBeGreaterThan(2);
    const totals = cashTotals(events);
    expect(all.totals).toEqual({ suppliers: 1, orders: totals.lines, units: totals.units, cash: totals.cash, lines_without_cost: totals.missingCost || undefined });
    // The first 8 lines of the supplier, in the calendar's own supplier order (the rest are counted).
    const group = bySupplier(events)[0]!;
    expect(linesOf(all)).toEqual(group.events.slice(0, 8).map((e) => ["Acme Textiles", e.variantId, e.qty, e.arrives, e.cost] as const).sort());
    expect(all.results![0]!._meta).toMatchObject({ orders: group.lines, units: group.units, cost: group.cash, more_lines: group.lines - 8 });
    const weeks = all.cash_per_week as { week_of: string; orders: number; units: number; cash: number | null }[];
    expect(weeks.map((w) => [w.week_of, w.orders, w.units, w.cash])).toEqual(
      planWeeks(calendar.plan).filter((w) => w.lines > 0).map((w) => [w.weekStart, w.lines, w.units, w.cash]),
    );

    // Today (within_days 1) = Order now's lines and quantities (net of the 20 units on the sent Keha order).
    const today = await body("get_order_plan", "within_days=1");
    const nowLines = orderNow.groups.flatMap((g) => g.lines.map((l) => [g.name, l.variantId, l.suggested] as const)).sort();
    expect(today.results!.flatMap((g) => (g._meta.lines as Line[]).map((l) => [g.name, l.variant_gid, l.order_qty] as const)).sort()).toEqual(nowLines);
    // V2 only: V1's 20 units on the sent Keha order land when an order placed today would, with more
    // than safety stock — its sales missed until then are lost, not owed (data audit #1).
    expect(nowLines.length).toBe(1);
    // Order-by dates are the forward plan's (overdue: the date that passed).
    for (const l of today.results![0]!._meta.lines as Line[]) expect(l.order_by).toBe(calendar.plan.variants[l.variant_gid]!.deadline);
    // M3: V2 is already out and the day it ran out isn't known: overdue with no date, never one made up.
    expect((today.results![0]!._meta.lines as (Line & { overdue?: boolean })[]).find((l) => l.variant_gid === V(2))).toMatchObject({ order_by: null, overdue: true });
    expect(today.results![0]!._meta).toMatchObject({ overdue: true, url: expect.stringMatching(/^app:\/\/app\/reorder\?supplier=supplier:s1&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/) });
    expect(today).toMatchObject({ url: "app://app/reorder/calendar", order_now_url: "app://app/reorder" });
    expect(today.cash_per_week).toBeUndefined();
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
      // The forward plan's (the same as Order now and Products): the 20 units on the sent Keha
      // order are netted (the stored nightly quantity, 65, predates that order). They land on day 21
      // with more than safety stock, so the next order is due on day 7; the sales missed while it is
      // sold out are lost, not ordered back (doesn't sell when out of stock, data audit #1).
      order_by: "2026-10-24",
      suggested_order_qty: 28,
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
    expect(r.results![0]!._meta.units_ordered).toBeUndefined();
    expect((await body("get_purchase_orders", "status=draft")).message).toBe(MSG.noOrders);
  });

  it("get_purchase_orders: a partly received order counts what is still to come; arrival = ship date + transit", async () => {
    db.tables.supplier = (db.tables.supplier ?? []).map((x) => (x.id === "s1" ? { ...x, transitDays: 10 } : x));
    if (!db.tables.supplier.some((x) => x.id === "s1")) db.tables.supplier.push({ id: "s1", shop: SHOP, name: "Acme Textiles", transitDays: 10 });
    Object.assign(db.tables.purchaseOrder[0]!, {
      status: "confirmed",
      confirmedShipDate: day("2026-10-25"),
      lines: [{ variantId: V(1), qty: 20, unitCost: 10, received: 8 }],
    });
    const r = await body("get_purchase_orders");
    const po1 = r.results!.find((x) => x.name.startsWith("PO-0001"))!;
    expect(po1._meta).toMatchObject({ units: 12, units_ordered: 20, value: 120, expected_arrival: "2026-11-04" });
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
    expect((await body("get_purchase_orders")).message).toBe(MSG.notAvailable);
    // The order plan: exactly the read-only preview the Free Order now page shows.
    const page = (await reorderLoader({ request: new Request("https://inventory.keha.io/app/reorder"), params: {}, context: {} } as never)) as ReorderPageData;
    expect(page.enabled).toBe(false);
    for (const q of ["", "within_days=90&supplier=acme"]) {
      const preview = await body("get_order_plan", q);
      expect(preview.results!.map((x) => [x.uri, x._meta.order_by, x._meta.suggested_order_qty, x._meta.days_left])).toEqual(
        page.preview!.map((p) => [p.variantId, p.orderBy, p.qty, p.daysLeft === null ? null : Math.floor(p.daysLeft)]),
      );
      expect(preview.results!.length).toBeGreaterThan(0);
      expect(JSON.stringify(preview)).not.toMatch(/supplier|cash|cost|calendar/i);
    }
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
    expect((await body("get_money_at_stake")).refreshed).toBe("weekly");
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

  it("not enough sales yet (2026-10-17 click-through): the order plan says it isn't ready and when — never 'nothing to order'", async () => {
    db.tables.salesDaily = db.tables.salesDaily!.slice(0, 5);
    const plan = await body("get_order_plan", "within_days=7");
    expect(plan.ready).toBe(false);
    expect(plan.results).toEqual([]);
    // 5 of 14 days: 9 more nights from 17 Oct (Madrid) → 26 Oct.
    expect(plan.message).toBe(
      "Order suggestions aren't ready yet: the first ones need 14 days of sales, expected on Mon 26 Oct 2026 (in 9 days). This doesn't mean nothing needs ordering.",
    );
    expect(plan.message).not.toBe(MSG.nothingToOrder);
    const stock = await body("get_product_stock", "query=hoodie");
    expect(stock).toMatchObject({ ready: false, order_advice: plan.message });
    expect(stock.results!.length).toBeGreaterThan(0);
    for (const r of stock.results!) expect(r._meta).toMatchObject({ order_by: null, suggested_order_qty: null });
  });

  it("still reading the store: the order plan gives how far the reading is", async () => {
    db.tables.shop![0]!.backfillState = { first90Ready: false, datasets: { products: { done: 1, total: 1 }, stock: { done: 6, total: 13 }, sales: { done: 4, total: 13 }, visits: { done: 0, total: 13 } } };
    const plan = await body("get_order_plan");
    expect(plan.ready).toBe(false);
    expect(plan.message).toMatch(/^Order suggestions aren't ready yet: Keha Inventory Planner is still reading this store's data \(\d+% done\)\./);
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
