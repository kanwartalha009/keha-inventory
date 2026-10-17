/**
 * app/lib/sidekick-shared.ts — the Sidekick tool responses: input parsing, dates,
 * app links, the order plan window and cash per currency, plan-aware product rows,
 * the token budget (rows dropped from the end, "Showing N of M"), and the content
 * policy on every built response.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_ROWS,
  MSG,
  RESPONSE_MAX_CHARS,
  accuracyResponse,
  actionListResponse,
  appUrl,
  dayLabel,
  fitResponse,
  link,
  moneyResponse,
  orderPlanResponse,
  productStockResponse,
  purchaseOrdersResponse,
  readActionKind,
  readMonths,
  readPoStatus,
  readText,
  readWithinDays,
  orderPreviewResponse,
  weekLabel,
  searchWords,
  sizeOf,
  variantPath,
  type ProductStockIn,
} from "../app/lib/sidekick-shared";
import { policyViolations } from "./helpers/sidekick-policy";
import { PLAN_TODAY, orderPlanFixture } from "./order-plan-fixtures";
import { previewRows, planWeeks, type PlanSupplierInfo, type PlanVariantInfo } from "../app/lib/order-plan-shared";
import { cashTotals, planEnd } from "../app/lib/engine/forward-plan-shared";
import { addDays } from "../app/lib/engine/dates-shared";

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const TODAY = "2026-10-17";

describe("inputs", () => {
  it("parses and clamps every input", () => {
    expect(readWithinDays(null)).toBe(14);
    expect(readWithinDays("")).toBe(14);
    expect(readWithinDays("7")).toBe(7);
    expect(readWithinDays("0")).toBe(1);
    expect(readWithinDays("400")).toBe(90);
    expect(readWithinDays("abc")).toBe(14);
    expect(readMonths(null)).toBe(3);
    expect(readMonths("20")).toBe(12);
    expect(readActionKind("Reorder")).toBe("reorder");
    expect(readActionKind("fix_sizes")).toBeNull();
    // Plain word for the sold-out tab; the old enum value still works.
    expect(readActionKind("sold_out")).toBe("bridge");
    expect(readActionKind("bridge")).toBe("bridge");
    expect(readPoStatus("SENT")).toBe("sent");
    expect(readPoStatus("received")).toBeNull();
    expect(readText("   ")).toBeNull();
    expect(readText("  blue   hoodie ")).toBe("blue hoodie");
    expect(readText("x".repeat(500))!.length).toBe(200);
  });

  it("splits a search into at most 5 distinct words", () => {
    expect(searchWords("blue hoodie")).toEqual(["blue", "hoodie"]);
    expect(searchWords("Blue blue / M, L")).toEqual(["Blue", "M", "L"]);
    expect(searchWords("a b c d e f g")).toHaveLength(5);
    expect(searchWords(null)).toEqual([]);
  });
});

describe("dates and links", () => {
  it("labels days with the weekday and how far they are", () => {
    expect(dayLabel("2026-10-24", TODAY)).toBe("Sat 24 Oct 2026 (in 7 days)");
    expect(dayLabel("2026-10-17", TODAY)).toBe("Sat 17 Oct 2026 (today)");
    expect(dayLabel("2026-10-18", TODAY)).toBe("Sun 18 Oct 2026 (tomorrow)");
    expect(dayLabel("2026-10-14", TODAY)).toBe("Wed 14 Oct 2026 (3 days ago)");
    expect(dayLabel(null, TODAY)).toBeNull();
    expect(dayLabel("soon", TODAY)).toBeNull();
  });

  it("builds app: links to our pages", () => {
    expect(appUrl("/app/reorder")).toBe("app://app/reorder");
    expect(variantPath(V(42))).toBe("/app/products/42");
    expect(weekLabel("2026-10-12")).toBe("Mon 12 Oct – Sun 18 Oct 2026");
    expect(dayLabel("2026-09-29", TODAY)).toBe("Tue 29 Sep 2026 (18 days ago)");
  });
});

// The forward plan fixture (tests/order-plan-fixtures.ts, today 2026-10-16): Lisbon Linen (s1) with an
// overdue shirt and trousers due today, then every two weeks; Mug (vendor Acme, no cost) from 11 Dec;
// Cap Co (s2) on 6 Jan.
describe("order plan (the forward plan the Order plan screens show)", () => {
  const plan = orderPlanFixture();

  it("this week: Order now's orders by supplier, overdue first, with order-by dates, cash and the Order now link", () => {
    const r = orderPlanResponse(plan, { supplier: null, withinDays: 7 });
    expect(r).toMatchObject({ within_days: 7, order_by_until: "2026-10-22", currency: "EUR", url: "app://app/reorder/calendar", order_now_url: "app://app/reorder" });
    expect(r.results!.map((x) => [x.uri, x.name])).toEqual([["gid://keha-inventory/Supplier/s1", "Lisbon Linen"]]);
    const meta = r.results![0]!._meta as Record<string, unknown> & { lines: Record<string, unknown>[] };
    // A1: the shirt is short by more than one lead time — overdue, no date, the day it runs out.
    expect(meta).toMatchObject({ grouped_by: "supplier", order_by: null, overdue: true, orders: 2, products: 2, units: 66, cost: 1016 });
    expect(meta.order_by_label).toBe("overdue — runs out Sun 18 Oct 2026 (in 2 days)");
    expect(meta.lines.map((l) => [l.variant_gid, l.order_qty, l.order_by, l.overdue, l.arrives, l.days_left])).toEqual([
      [V(1), 38, null, true, "2026-10-30", 2],
      // Ordered on its own order-by date (tomorrow), not today (audit 2026-10-17).
      [V(2), 28, "2026-10-17", undefined, "2026-10-31", 20],
    ]);
    expect(meta.url).toBe("app://app/reorder?supplier=supplier:s1&from=2026-10-16&to=2026-10-17");
    expect(r.totals).toEqual({ suppliers: 1, orders: 2, units: 66, cash: 1016 });
    expect(r.cash_per_week).toBeUndefined();
  });

  it("the next 13 weeks: the whole calendar by supplier, cash per week, unknown costs counted (never 0)", () => {
    const r = orderPlanResponse(plan, { supplier: null, withinDays: 90 });
    const totals = cashTotals(plan.events);
    expect(r.totals).toEqual({ suppliers: 3, orders: totals.lines, units: totals.units, cash: totals.cash, lines_without_cost: totals.missingCost });
    expect(r.results!.map((x) => x.name)).toEqual(["Lisbon Linen", "Acme", "Cap Co"]);
    expect(r.results![1]!._meta).toMatchObject({ grouped_by: "vendor (no supplier set)", cost: null, lines_without_cost: 3 });
    const weeks = r.cash_per_week as { week_of: string; orders: number; cash: number | null }[];
    expect(weeks.map((w) => [w.week_of, w.orders, w.cash])).toEqual(
      planWeeks(plan).filter((w) => w.lines > 0).map((w) => [w.weekStart, w.lines, w.cash]),
    );
    expect(r.order_by_until).toBe(planEnd(PLAN_TODAY));
    // 30 days: through 14 Nov.
    const month = orderPlanResponse(plan, { supplier: null, withinDays: 30 });
    expect(month.order_by_until).toBe("2026-11-14");
    expect(month.totals).toMatchObject({ orders: 6 });
  });

  it("filters by supplier or vendor name; neutral messages when there is nothing", () => {
    expect(orderPlanResponse(plan, { supplier: "cap", withinDays: 90 }).results!.map((x) => x.name)).toEqual(["Cap Co"]);
    // Never "nothing to order" without the products the plan couldn't plan (fixture: 12 no data, 1 dead).
    const NOT_PLANNED = "12 products can't be planned yet — not enough sales history. 1 product isn't selling (dead stock), so it isn't reordered. They are not in this answer.";
    const cap7 = orderPlanResponse(plan, { supplier: "cap", withinDays: 7 });
    expect(cap7.message).toBe(`${MSG.nothingToOrder} ${NOT_PLANNED}`);
    expect(cap7.not_planned).toBe(NOT_PLANNED);
    expect(orderPlanResponse(plan, { supplier: "nobody", withinDays: 90 }).message).toBe(MSG.noSupplierMatch);
    expect(orderPlanResponse(orderPlanFixture({ events: [] }), { supplier: null, withinDays: 14 }).message).toBe(`${MSG.nothingToOrder} ${NOT_PLANNED}`);
    expect(orderPlanResponse({ ...orderPlanFixture({ events: [] }), cantPlan: { noData: 0, dead: 0 } }, { supplier: null, withinDays: 14 }).message).toBe(MSG.nothingToOrder);
    expect(orderPlanResponse(plan, { supplier: null, withinDays: 90 }).not_planned).toBe(NOT_PLANNED);
  });

  it("shows at most 8 lines per supplier and counts the rest", () => {
    const meta = orderPlanResponse(plan, { supplier: "lisbon", withinDays: 90 }).results![0]!._meta as { lines: unknown[]; more_lines: number; orders: number };
    expect(meta.lines).toHaveLength(8);
    expect(meta.more_lines).toBe(meta.orders - 8);
  });

  it("the read-only preview: exactly the app's top 10 rows, no suppliers, costs or calendar", () => {
    const rows = previewRows(plan);
    const r = orderPreviewResponse(rows, plan);
    expect(r.url).toBe("app://app/reorder");
    expect(r.results!.map((x) => [x.uri, x._meta.order_by, x._meta.suggested_order_qty])).toEqual(rows.map((x) => [x.variantId, x.orderBy, x.qty]));
    expect(r.results![0]).toMatchObject({ name: "Linen shirt — M", _meta: { days_left: 2, order_by: null, order_by_label: "overdue — runs out Sun 18 Oct 2026 (in 2 days)", overdue: true, suggested_order_qty: 38 } });
    const text = JSON.stringify(r);
    for (const word of ["supplier", "cost", "cash", "calendar"]) expect(text).not.toContain(word);
    expect(orderPreviewResponse([], plan).message).toMatch(new RegExp(`^${MSG.nothingToOrder} 12 products can't be planned yet`));
    expect(orderPreviewResponse([], { ...plan, cantPlan: { noData: 0, dead: 0 } }).message).toBe(MSG.nothingToOrder);
  });
});

/** A large forward plan (30 suppliers × 20 variants, an order every week) for the budget test. */
function bigPlan() {
  const events = [];
  const variants: Record<string, PlanVariantInfo> = {};
  const suppliers: Record<string, PlanSupplierInfo> = {};
  for (let s = 0; s < 30; s++) {
    suppliers[`supplier:s${s}`] = { key: `supplier:s${s}`, kind: "supplier", supplierId: `s${s}`, name: `Supplier with a fairly long name ${s}` };
    for (let i = 0; i < 20; i++) {
      const id = V(s * 100 + i);
      variants[id] = { variantId: id, productId: `P${s}-${i}`, productTitle: "A product with a long descriptive title", variantTitle: "Extra large / Midnight blue", sku: `SKU-${s}-${i}`, image: null, daysLeft: 10, neverRunsOut: false, deadline: TODAY, valuePerDay: 1 };
      for (let w = 0; w < 13; w++) {
        const day = addDays(TODAY, w * 7);
        events.push({ variantId: id, productId: `P${s}-${i}`, supplierKey: `supplier:s${s}`, orderBy: day, arrives: addDays(day, 14), qty: 12, unitCost: 2, cost: 24, overdue: false, deadline: day });
      }
    }
  }
  return orderPlanFixture({ today: TODAY, events, variants, suppliers });
}

function stockRow(over: Partial<ProductStockIn> = {}): ProductStockIn {
  return {
    id: V(7),
    productId: "gid://shopify/Product/70",
    productTitle: "Hoodie",
    variantTitle: "Blue / M",
    sku: "HD-BL-M",
    status: "running_low",
    onHand: 9,
    incoming: null,
    rate: 1.26,
    daysLeft: 7.9,
    neverRunsOut: false,
    orderBy: "2026-10-20",
    orderQty: 30,
    onOrder: 0,
    onOrderArrival: null,
    ...over,
  };
}

describe("product stock", () => {
  it("uses the app's status words and keeps unknown values null, never 0", () => {
    const r = productStockResponse([stockRow()], { query: "blue hoodie", total: 1, forecast: true, today: TODAY });
    expect(r.results![0]).toMatchObject({
      uri: V(7),
      name: "Hoodie — Blue / M",
      _meta: {
        product_gid: "gid://shopify/Product/70",
        status: "Running low",
        on_hand: 9,
        incoming: null,
        sales_per_day: 1.3,
        days_left: 7,
        order_by: "2026-10-20",
        order_by_label: "Tue 20 Oct 2026 (in 3 days)",
        suggested_order_qty: 30,
        url: "app://app/products/7",
      },
    });
    const never = productStockResponse([stockRow({ neverRunsOut: true, daysLeft: null, status: null, onOrder: 20, onOrderArrival: "2026-11-02" })], {
      query: "x",
      total: 1,
      forecast: true,
      today: TODAY,
    });
    // Stock but no sale to measure a pace from: unknown (null) with the reason, never "never runs out".
    expect(never.results![0]!._meta).toMatchObject({ days_left: null, days_left_why: "no recent sales", status: null, on_order_with_keha: 20, keha_order_arrival: "2026-11-02" });
  });

  it("leaves the forecast fields out when the store's plan doesn't show them", () => {
    const r = productStockResponse([stockRow({ daysLeft: null, orderBy: null, orderQty: null })], { query: "x", total: 1, forecast: false, today: TODAY });
    const meta = r.results![0]!._meta;
    for (const k of ["days_left", "order_by", "order_by_label", "suggested_order_qty"]) expect(meta).not.toHaveProperty(k);
    expect(meta).toMatchObject({ status: "Running low", on_hand: 9 });
  });

  it("says when nothing matches", () => {
    expect(productStockResponse([], { query: "x", total: 0, forecast: true, today: TODAY })).toEqual({ query: "x", results: [], message: MSG.noProducts });
  });
});

describe("token budget", () => {
  it("caps rows at 15 and says how many more there are", () => {
    const rows = Array.from({ length: 40 }, (_, i) => stockRow({ id: V(i + 1) }));
    const r = productStockResponse(rows.slice(0, MAX_ROWS), { query: "tee", total: 40, forecast: true, today: TODAY });
    expect(r.results).toHaveLength(15);
    expect(r.note).toBe("Showing 15 of 40 matching variants; 25 more are in the app.");
  });

  it("drops rows from the end until the response fits", () => {
    const big = Array.from({ length: 15 }, (_, i) => link(`gid://x/${i}`, `Row ${i}`, "application/x", { blob: "y".repeat(2_000) }));
    const r = fitResponse({ results: big }, { what: "rows" });
    expect(sizeOf(r)).toBeLessThanOrEqual(RESPONSE_MAX_CHARS);
    expect(r.results!.length).toBeLessThan(15);
    expect(r.results!.length).toBeGreaterThan(3);
    expect(r.note).toBe(`Showing ${r.results!.length} of 15 rows; ${15 - r.results!.length} more are in the app.`);
    // Small responses are untouched.
    expect(fitResponse({ results: big.slice(0, 2).map((x) => ({ ...x, _meta: {} })) }).note).toBeUndefined();
  });

  it("keeps the largest realistic responses under the budget", () => {
    const plan = orderPlanResponse(bigPlan(), { supplier: null, withinDays: 90 });
    expect(sizeOf(plan)).toBeLessThanOrEqual(RESPONSE_MAX_CHARS);
    expect(plan.note).toMatch(/^Showing \d+ of 30 suppliers; \d+ more are in the app\.$/);
    expect(plan.totals).toMatchObject({ suppliers: 30, units: 30 * 20 * 13 * 12 });
    expect((plan.cash_per_week as unknown[]).length).toBe(13);
  });
});

describe("other tools", () => {
  it("action list: kind filter, reason sentence, the app's own row limit stated plainly", () => {
    const rows = [
      { kind: "reorder", tab: "reorder", productId: "gid://shopify/Product/1", productTitle: "Hoodie", variants: ["S", "M"], amount: 300.456, currency: "EUR", reasonText: "Runs out in 5 days.", path: "/app/reorder?variants=1" },
      { kind: "clear", tab: "clear", productId: "gid://shopify/Product/2", productTitle: "Cap", variants: [], amount: 120, currency: "EUR", reasonText: "No sale for 120 days.", path: "/app?tab=clear" },
    ];
    const all = actionListResponse(rows, { kind: null, currency: "EUR", limited: 10 });
    expect(all.results!.map((r) => r._meta.action)).toEqual(["Reorder", "Clear (discount slow or dead stock)"]);
    expect(all.results![0]!._meta).toMatchObject({ variants: "S, M", money_at_stake: 300.46, why: "Runs out in 5 days.", url: "app://app/reorder?variants=1" });
    expect(all.note).toBe("Ranked by money at stake; the list covers the 10 largest actions.");
    const clear = actionListResponse(rows, { kind: "clear", currency: "EUR", limited: null });
    expect(clear.results).toHaveLength(1);
    expect(clear.url).toBe("app://app?tab=clear");
    expect(clear.note).toBeUndefined();
    expect(actionListResponse(rows, { kind: "push", currency: "EUR", limited: null }).message).toBe(MSG.noActions);
    // The sold-out kind answers in plain words: kind sold_out, no "bridge" in the text.
    const soldOut = actionListResponse(
      [{ kind: "bridge", tab: "bridge", productId: "gid://shopify/Product/3", productTitle: "Boots", variants: [], amount: 90, currency: "EUR", reasonText: "Sold out until 2 Nov.", path: "/app?tab=bridge" }],
      { kind: "bridge", currency: "EUR", limited: null },
    );
    expect(soldOut.kind).toBe("sold_out");
    expect(soldOut.results![0]!._meta.action).toBe("While sold out: collect back-in-stock sign-ups until stock arrives");
    expect(JSON.stringify({ ...soldOut, url: undefined, results: soldOut.results!.map((r) => ({ ...r._meta, url: undefined })) })).not.toMatch(/bridge/i);
  });

  it("money at stake: card titles, how we got this, dead stock basis", () => {
    const r = moneyResponse(
      {
        day: "2026-10-16",
        currency: "EUR",
        refresh: "daily",
        cards: [
          { key: "atRisk", value: 1234.567, how: "Based on: x" },
          { key: "lost90", value: null, how: "" },
        ],
        dead: { cash: 900, units: 50, variants: 3, retail: true, deadDays: 90 },
      },
      TODAY,
    );
    expect(r.cards).toEqual([
      { name: "Sales at risk (next 28 days)", amount: 1234.57, how_we_got_this: "Based on: x" },
      { name: "Sales lost to sell-outs (last 90 days)", amount: null, how_we_got_this: null },
    ]);
    expect(r.dead_stock).toMatchObject({ amount: 900, units: 50, variants: 3, valued_at: "cost, or retail price where a variant has no cost" });
    expect(String((r.dead_stock as { how_we_got_this: string }).how_we_got_this)).toContain("90 days");
    expect(r.as_of_label).toBe("Fri 16 Oct 2026 (yesterday)");
  });

  it("purchase orders: status and supplier filters, Shopify orders marked", () => {
    const base = { units: 20, cost: 200, currency: "EUR", createdAt: "2026-10-01T09:00:00.000Z" };
    const rows = [
      { ...base, id: "po1", number: "PO-0001", source: "keha" as const, status: "sent", supplierName: "Acme", arrival: "2026-11-01" },
      { ...base, id: "po2", number: "#PO-7", source: "shopify" as const, status: "sent", supplierName: null, arrival: null, cost: null, currency: null },
      { ...base, id: "po3", number: "PO-0002", source: "keha" as const, status: "draft", supplierName: "Pacific", arrival: null },
    ];
    const ctx = { status: null, supplier: null, today: TODAY, storeCurrency: "EUR" };
    const all = purchaseOrdersResponse(rows, ctx);
    expect(all.results!.map((r) => [r.name, r._meta.status, r._meta.created_in])).toEqual([
      ["PO-0001 — Acme", "Sent", "Keha"],
      ["#PO-7", "Ordered", "Shopify"],
      ["PO-0002 — Pacific", "Draft (not sent yet)", "Keha"],
    ]);
    expect(all.results![1]!._meta).toMatchObject({ value: null, currency: "EUR", url: "app://app/reorder/po2" });
    expect(purchaseOrdersResponse(rows, { ...ctx, status: "draft" }).results).toHaveLength(1);
    expect(purchaseOrdersResponse(rows, { ...ctx, supplier: "acm" }).results).toHaveLength(1);
    expect(purchaseOrdersResponse(rows, { ...ctx, status: "confirmed" }).message).toBe(MSG.noOrders);
  });

  it("forecast accuracy: months newest first, one decimal, null kept", () => {
    expect(accuracyResponse([]).message).toBe(MSG.noAccuracy);
    expect(accuracyResponse([{ month: "2026-09-01", storeErrorPct: 12.345, top20ErrorPct: null, graded: 18 }]).months).toEqual([
      { month: "2026-09", store_total_error_pct: 12.3, top_20_products_error_pct: null, variants_graded: 18 },
    ]);
  });

  it("no response text breaks the content policy", () => {
    const texts = [
      orderPlanResponse(orderPlanFixture(), { supplier: null, withinDays: 90 }),
      orderPreviewResponse(previewRows(orderPlanFixture()), orderPlanFixture()),
      productStockResponse([stockRow()], { query: "x", total: 1, forecast: true, today: TODAY }),
      accuracyResponse([]),
    ].map((r) => JSON.stringify(r));
    expect(texts.flatMap(policyViolations)).toEqual([]);
  });
});

describe("daysLeftMeta (2026-10-17: no recent sales is unknown, never ∞)", () => {
  it("null with the reason when there is stock but no sales pace; whole days otherwise", async () => {
    const { daysLeftMeta, NO_RECENT_SALES } = await import("../app/lib/sidekick-shared");
    expect(daysLeftMeta(null, true)).toEqual({ days_left: null, days_left_why: NO_RECENT_SALES });
    expect(daysLeftMeta(null, false)).toEqual({ days_left: null });
    expect(daysLeftMeta(9.7, false)).toEqual({ days_left: 9 });
    expect(daysLeftMeta(-2, false)).toEqual({ days_left: 0 });
    expect(JSON.stringify(daysLeftMeta(null, true))).not.toMatch(/never|∞/);
  });
});

describe("order plan not ready (2026-10-17 click-through: never 'nothing to order' before the store is ready)", () => {
  it("says why and when, neutrally; product stock keeps stock but drops the order fields", async () => {
    const { notReadyMessage, notReadyResponse, cantPlanNote } = await import("../app/lib/sidekick-shared");
    const { policyViolations } = await import("./helpers/sidekick-policy");
    const noSales = notReadyMessage({ ready: false, state: "noSales", readyOn: "2026-10-31" }, "2026-10-17");
    expect(noSales).toBe("Order suggestions aren't ready yet: the first ones need 14 days of sales, expected on Sat 31 Oct 2026 (in 14 days). This doesn't mean nothing needs ordering.");
    const syncing = notReadyMessage({ ready: false, state: "syncing", percent: 43 }, "2026-10-17");
    expect(syncing).toContain("still reading this store's data (43% done)");
    expect(notReadyMessage({ ready: false, state: "noTracked" }, "2026-10-17")).toBe(MSG.noTracked);
    const r = notReadyResponse({ ready: false, state: "noSales", readyOn: null }, "2026-10-17", { url: "app://app/reorder" });
    expect(r).toEqual({ url: "app://app/reorder", ready: false, results: [], message: "Order suggestions aren't ready yet: the first ones need 14 days of sales. This doesn't mean nothing needs ordering." });
    for (const text of [noSales, syncing, r.message!, cantPlanNote({ noData: 2, dead: 3 })!]) {
      expect(policyViolations(text)).toEqual([]);
      // "nothing needs ordering" appears only as what the answer does NOT mean.
      expect(text.replace("This doesn't mean nothing needs ordering.", "")).not.toMatch(/nothing (needs|to)/i);
      expect(text).not.toMatch(/\bplan\b/i);
    }
    expect(cantPlanNote({ noData: 0, dead: 0 })).toBeNull();
    expect(cantPlanNote({ noData: 1, dead: 0 })).toBe("1 product can't be planned yet — not enough sales history. They are not in this answer.");

    const out = productStockResponse([stockRow({ status: "out", onHand: 0, rate: null, daysLeft: 0, orderBy: "2026-10-20", orderQty: 12 })], {
      query: "x",
      total: 1,
      forecast: true,
      today: "2026-10-17",
      notReady: { ready: false, state: "noSales", readyOn: "2026-10-31" },
    });
    expect(out).toMatchObject({ ready: false, order_advice: noSales });
    expect(out.results![0]!._meta).toMatchObject({ status: "Out", on_hand: 0, sales_per_day: null, days_left: 0, order_by: null, order_by_label: null, suggested_order_qty: null });
  });
});
