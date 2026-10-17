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
  reorderPath,
  searchWords,
  sizeOf,
  variantPath,
  type PlanGroupIn,
  type ProductStockIn,
} from "../app/lib/sidekick-shared";
import { policyViolations } from "./helpers/sidekick-policy";

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
    expect(reorderPath([V(1), V(2), V(1), "junk"])).toBe("/app/reorder?variants=1,2");
    expect(reorderPath([])).toBe("/app/reorder");
    expect(variantPath(V(42))).toBe("/app/products/42");
  });
});

function group(over: Partial<PlanGroupIn> = {}, lines: Partial<PlanGroupIn["lines"][number]>[] = [{}]): PlanGroupIn {
  return {
    key: "supplier:s1",
    kind: "supplier",
    supplierId: "s1",
    name: "Acme Textiles",
    leadTimeDays: 21,
    currency: "EUR",
    ...over,
    lines: lines.map((l, i) => ({
      variantId: V(i + 1),
      productTitle: "Hoodie",
      variantTitle: `Size ${i + 1}`,
      sku: `HD-${i + 1}`,
      onHand: 4,
      daysLeft: 6.7,
      orderBy: "2026-10-20",
      suggested: 12,
      unitCost: 10,
      ...l,
    })),
  };
}

describe("order plan", () => {
  const ctx = { today: TODAY, cutoff: "2026-10-31", storeCurrency: "EUR" };

  it("keeps lines due by the cutoff (overdue and undated included), with order-by labels and links", () => {
    const g = group({}, [{ orderBy: "2026-10-12" }, { orderBy: "2026-10-30" }, { orderBy: "2026-11-20" }, { orderBy: null, unitCost: null }]);
    const r = orderPlanResponse([g], { supplier: null, withinDays: 14 }, ctx);
    expect(r.results).toHaveLength(1);
    const meta = r.results![0]!._meta as Record<string, unknown> & { lines: { variant_gid: string; days_left: number }[] };
    expect(r.results![0]).toMatchObject({ type: "resource_link", uri: "gid://keha-inventory/Supplier/s1", name: "Acme Textiles", mimeType: "application/vnd.keha.supplier-order" });
    expect(meta.lines.map((l) => l.variant_gid)).toEqual([V(1), V(2), V(4)]);
    expect(meta.order_by).toBe("2026-10-12");
    expect(meta.order_by_label).toBe("Mon 12 Oct 2026 (5 days ago)");
    expect(meta.units).toBe(36);
    expect(meta.cost).toBe(240);
    expect(meta.lines_without_cost).toBe(1);
    expect(meta.lines[0]!.days_left).toBe(6);
    expect(meta.url).toBe("app://app/reorder?variants=1,2,4");
    expect(r.totals).toEqual({ suppliers: 1, units: 36, cash: [{ currency: "EUR", amount: 240, lines_without_cost: 1 }] });
    expect(r.order_by_until).toBe("2026-10-31");
  });

  it("keeps cash per currency and filters by supplier name", () => {
    const usd = group({ key: "supplier:s2", supplierId: "s2", name: "Pacific Caps", currency: "USD" }, [{ unitCost: 2.5, suggested: 10 }]);
    const vendor = group({ key: "vendor:capco", kind: "vendor", supplierId: null, name: "" }, [{ unitCost: null }]);
    const all = orderPlanResponse([group(), usd, vendor], { supplier: null, withinDays: 14 }, ctx);
    expect(all.totals).toMatchObject({ suppliers: 3, cash: [{ currency: "EUR", amount: 120, lines_without_cost: 1 }, { currency: "USD", amount: 25 }] });
    expect(all.results![2]).toMatchObject({ uri: "gid://keha-inventory/Vendor/none", name: "Products without a vendor", _meta: { grouped_by: "vendor (no supplier set)", cost: null } });
    const one = orderPlanResponse([group(), usd], { supplier: "pacific", withinDays: 14 }, ctx);
    expect(one.results!.map((x) => x.name)).toEqual(["Pacific Caps"]);
    expect(orderPlanResponse([group(), usd], { supplier: "nobody", withinDays: 14 }, ctx).message).toBe(MSG.noSupplierMatch);
    expect(orderPlanResponse([], { supplier: null, withinDays: 14 }, ctx).message).toBe(MSG.nothingToOrder);
    expect(orderPlanResponse([group({}, [{ orderBy: "2026-12-01" }])], { supplier: null, withinDays: 14 }, ctx)).toMatchObject({
      results: [],
      message: MSG.nothingToOrder,
    });
  });

  it("shows at most 8 lines per supplier and counts the rest", () => {
    const r = orderPlanResponse([group({}, Array.from({ length: 11 }, () => ({})))], { supplier: null, withinDays: 14 }, ctx);
    const meta = r.results![0]!._meta as { lines: unknown[]; more_lines: number; units: number };
    expect(meta.lines).toHaveLength(8);
    expect(meta.more_lines).toBe(3);
    expect(meta.units).toBe(132);
  });
});

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
    expect(never.results![0]!._meta).toMatchObject({ days_left: "never runs out at the current pace", status: null, on_order_with_keha: 20, keha_order_arrival: "2026-11-02" });
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
    const groups = Array.from({ length: 30 }, (_, i) =>
      group({ key: `supplier:s${i}`, supplierId: `s${i}`, name: `Supplier with a fairly long name ${i}` }, Array.from({ length: 20 }, () => ({ productTitle: "A product with a long descriptive title", variantTitle: "Extra large / Midnight blue" }))),
    );
    const plan = orderPlanResponse(groups, { supplier: null, withinDays: 90 }, { today: TODAY, cutoff: "2027-01-15", storeCurrency: "EUR" });
    expect(sizeOf(plan)).toBeLessThanOrEqual(RESPONSE_MAX_CHARS);
    expect(plan.note).toMatch(/^Showing \d+ of 30 suppliers; \d+ more are in the app\.$/);
    expect(plan.totals).toMatchObject({ suppliers: 30, units: 30 * 20 * 12 });
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
      orderPlanResponse([group()], { supplier: null, withinDays: 14 }, { today: TODAY, cutoff: "2026-10-31", storeCurrency: "EUR" }),
      productStockResponse([stockRow()], { query: "x", total: 1, forecast: true, today: TODAY }),
      accuracyResponse([]),
    ].map((r) => JSON.stringify(r));
    expect(texts.flatMap(policyViolations)).toEqual([]);
  });
});
