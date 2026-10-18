/**
 * Order plan (Kanwar 2026-10-17): Next 13 weeks (Growth / Free / empty), the shared helpers
 * (Order this week, the Free preview, links, CSV) on a plan built with the real forward plan.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/services/entitlements.server", () => ({
  getEntitlements: vi.fn(),
  upgradeResponse: vi.fn((feature: string) => Response.json({ ok: false, upgrade: { feature } }, { status: 403 })),
}));
vi.mock("../app/models/order-plan.server", () => ({ loadOrderPlan: vi.fn() }));
vi.mock("../app/models/reorder.server", () => ({ shopBasics: vi.fn(async () => ({ currency: "EUR", timezone: "UTC", locale: "de", leadTimeDays: 14 })) }));

import OrderCalendar, { loader as calendarLoader, type CalendarPageData } from "../app/routes/app.reorder_.calendar";
import { loader as csvLoader } from "../app/routes/app.reorder_.calendar_.csv";
import { authenticate } from "../app/shopify.server";
import { getEntitlements } from "../app/services/entitlements.server";
import { loadOrderPlan } from "../app/models/order-plan.server";
import { featureMap } from "../app/lib/plan-shared";
import { EMPTY_ORDER_PLAN, aboveLastYear, dueText, formatWeekRange, lastYearLine, lockTeaser, orderLink, planCsv, planWeeks, previewRows, supplierName, thisWeek, whyLines, whySum } from "../app/lib/order-plan-shared";
import { LocaleProvider, translate } from "../app/lib/i18n";
import { DueLabel } from "../app/components/order-plan";
import { dueState } from "../app/lib/engine/forward-plan-shared";
import { PLAN_TODAY, orderPlanFixture } from "./order-plan-fixtures";

function render(data: CalendarPageData) {
  const Stub = createRoutesStub([{ id: "cal", path: "/app/reorder/calendar", Component: OrderCalendar, loader: () => data }]);
  return renderToString(<Stub initialEntries={["/app/reorder/calendar"]} hydrationData={{ loaderData: { cal: data } }} />);
}

describe("Order calendar", () => {
  it("Growth: summary, cash strip, 13 week rows, the first busy week open with its suppliers and lines", () => {
    const html = render({ enabled: true, plan: orderPlanFixture() });
    expect(html).toMatch(/aria-selected="true" class="keha-tab keha-tab--active">Order calendar</);
    expect(html).toMatch(/\d+ orders in the next 13 weeks · [\d,]+ units · €[\d,]+/);
    expect(html).toContain("keha-orderplan-strip");
    expect(html.split("keha-orderplan-week ").length - 1 + (html.split("keha-orderplan-week\"").length - 1)).toBe(13);
    expect(html).toMatch(/Oct 12\s–\s18/); // this ISO week (Intl uses thin spaces)
    expect(html).toContain("Overdue");
    expect(html).toContain("Lisbon Linen");
    expect(html).toContain("Create purchase order");
    // Create order → Order now with that supplier's orders of the week (resolved on the server).
    expect(html).toContain('href="/app/reorder?supplier=supplier:s1&amp;from=2026-10-16&amp;to=2026-10-17"');
    // Each line: its real deadline and "Why this quantity" from the plan's own terms.
    // A1: the shirt is short by more than one lead time — "Overdue" with the day it runs out.
    expect(html).toContain("Overdue · runs out Oct 18");
    expect(html).toContain("Due Oct 17");
    expect(html).toContain("Forecast for the next 28 days: 56 (sales per day 2, season ×1) + safety 10 − on hand 5 − on order 0 − sales it can&#x27;t cover (out of stock before it arrives) 23 = 38");
    // Unknown costs are counted, never 0.
    expect(html).toMatch(/\d+ lines without a cost price are not in the cash totals\./);
    expect(html).toContain("12 products can&#x27;t be planned yet — not enough sales history.");
    expect(html).toContain("1 product isn&#x27;t selling (dead stock), so it isn&#x27;t reordered.");
    expect(html).toContain("Download CSV");
  });

  it("no suppliers yet: grouped by vendor, with the way to add them", () => {
    const html = render({ enabled: true, plan: orderPlanFixture({ suppliersSetUp: false }) });
    expect(html).toContain("Grouped by vendor until you add your suppliers.");
    expect(html).toContain('href="/app/settings/suppliers"');
  });

  it("nothing to order", () => {
    const html = render({ enabled: true, plan: EMPTY_ORDER_PLAN(PLAN_TODAY, "EUR") });
    expect(html).toContain("No orders needed in the next 13 weeks.");
    expect(html).not.toContain("Download CSV");
    expect(html).not.toContain("Week by week");
  });

  it("nothing to order but products that can't be planned: the count line goes with it", () => {
    const html = render({ enabled: true, plan: { ...EMPTY_ORDER_PLAN(PLAN_TODAY, "EUR"), cantPlan: { noData: 2, dead: 0 } } });
    expect(html).toContain("No orders needed in the next 13 weeks.");
    expect(html).toContain("2 products can&#x27;t be planned yet — not enough sales history.");
  });

  it("not ready (2026-10-17 click-through): says why and when — never 'No orders needed'", () => {
    const html = render({
      enabled: true,
      plan: { ...EMPTY_ORDER_PLAN(PLAN_TODAY, "EUR"), cantPlan: { noData: 2, dead: 0 } },
      readiness: { ready: false, state: "noSales", readyOn: "2026-10-31" },
    });
    expect(html).toContain("Your order plan isn&#x27;t ready yet");
    expect(html).toContain("Your first order plan needs 14 days of sales — expected on Oct 31, 2026.");
    expect(html).not.toContain("No orders needed");
    const syncing = render({ enabled: true, plan: EMPTY_ORDER_PLAN(PLAN_TODAY, "EUR"), readiness: { ready: false, state: "syncing", percent: 43 } });
    expect(syncing).toContain("Still reading your store: 43%.");
  });

  it("Free (and below Growth): the tab bar stays and the tab teaches", () => {
    const html = render({ enabled: false, plan: EMPTY_ORDER_PLAN("") });
    expect(html).toContain("keha-tabs");
    expect(html).toContain("Order calendar · Growth plan");
    expect(html).toContain('href="/app/plans?upgrade=orderCalendar"');
    expect(html).not.toContain("Download CSV");
  });
});

const cashOf = (p: { events: { cost: number | null }[] }) => Math.round(p.events.reduce((a, e) => a + (e.cost ?? 0), 0) * 100) / 100;

describe("order-plan-shared", () => {
  const plan = orderPlanFixture();

  it("Order this week: overdue and due-within-7-days orders by supplier; the next order otherwise", () => {
    const w = thisWeek(plan);
    expect(w.suppliers[0]!.supplierKey).toBe("supplier:s1");
    expect(w.suppliers[0]!.overdue).toBe(true);
    expect(w.suppliers[0]!.products).toBe(2);
    expect(w.totals.units).toBe(w.suppliers.reduce((a, s) => a + s.units, 0));
    const later = thisWeek({ ...plan, events: plan.events.filter((e) => e.orderBy > "2026-10-22") });
    expect(later.suppliers).toEqual([]);
    expect(later.next).not.toBeNull();
    expect(thisWeek({ ...plan, events: [] }).next).toBeNull();
  });

  it("M4: a line adding up several orders says so, with each order's date", () => {
    const t = (x: string) => x;
    const w = (day: number, rounded: number, topUp = 0) => ({ day, days: 28, demand: 1, rate: 1, season: 1, growth: 1, safety: 1, onHand: 0, onOrder: 0, need: 1, rounded, pack: null, moq: null, topUp });
    expect(whySum([w(0, 30)], "2026-10-16", t, "en")).toEqual({ summary: null, headings: [null] });
    const two = whySum([w(0, 30), w(3, 40, 3)], "2026-10-16", t, "en");
    expect(two.summary).toBe("Orders due in the next 7 days (2), added together: 30 + 43 = 73");
    expect(two.headings).toEqual(["Order due Oct 16:", "Order due Oct 19:"]);
    expect(whySum([w(0, 30), w(3, 40)], "2026-10-16", (x) => translate("de", x), "de").summary).toBe("In den nächsten 7 Tagen fällige Bestellungen (2), zusammengezählt: 30 + 40 = 70");
  });

  it("due dates: Due today only when it is, Due 27 Oct, Overdue since 12 Oct", () => {
    const t = (x: string) => x;
    expect(dueText("2026-10-16", "2026-10-16", t, "en")).toBe("Due today");
    expect(dueText("2026-10-27", "2026-10-16", t, "en")).toBe("Due Oct 27");
    expect(dueText("2026-10-12", "2026-10-16", t, "en")).toBe("Overdue since Oct 12");
    expect(dueText(null, "2026-10-16", t, "en")).toBe("—");
    // M3: late with no date (already out, the day it ran out unknown): "Overdue", never a made-up date.
    expect(dueText(null, "2026-10-16", t, "en", true)).toBe("Overdue");
    expect(dueText("2026-10-27", "2026-10-16", (x) => translate("de", x), "de")).toBe("Bis 27. Okt.");
  });

  it("one label rule: an order-by date of today is Due today, never overdue — even with the overdue flag", () => {
    const t = (x: string) => x;
    expect(dueText("2026-10-16", "2026-10-16", t, "en", true)).toBe("Due today");
    expect(dueText("2026-10-17", "2026-10-16", t, "en", true)).toBe("Due Oct 17");
    expect(dueText("2026-10-15", "2026-10-16", t, "en", false)).toBe("Overdue since Oct 15");
    expect([dueState("2026-10-16", "2026-10-16", true), dueState("2026-10-15", "2026-10-16"), dueState(null, "2026-10-16", true), dueState(null, "2026-10-16")]).toEqual(["today", "overdue", "overdue", null]);
    // The badge follows the same rule.
    const html = renderToString(
      createElement(LocaleProvider, { defaultLocale: "en", children: createElement("div", null, createElement(DueLabel, { deadline: "2026-10-16", today: "2026-10-16", overdue: true })) }),
    );
    expect(html).toContain("Due today");
    expect(html).not.toContain("critical");
  });

  it("Why this quantity: the plan's terms, the rounding and the top-up, in the admin language", () => {
    const why = { day: 0, days: 28, demand: 56, rate: 2, season: 1.2, growth: 1, safety: 10, onHand: 5, onOrder: 3, need: 58, rounded: 60, pack: 12, moq: 50, topUp: 12 };
    const t = (x: string) => x;
    expect(whyLines(why, t, "en")).toEqual([
      "Forecast for the next 28 days: 56 (sales per day 2, season ×1.2) + safety 10 − on hand 5 − on order 3 = 58",
      "→ rounded to 60 (case pack 12 / minimum 50)",
      "+ 12 to reach the supplier's minimum order = 72",
    ]);
    expect(whyLines({ ...why, day: 9, growth: 1.25, pack: null, moq: null, topUp: 0 }, t, "en")).toEqual([
      "Forecast for the 28 days from this order: 56 (sales per day 2, season ×1.2) + safety 10 − stock expected then 5 − on order 3 = 58",
      "Growth assumption ×1.25 included in the forecast.",
      "→ rounded to 60",
    ]);
    expect(whyLines(why, (x) => translate("de", x), "de")[0]).toContain("Prognose für die nächsten 28 Tage");
  });

  it("Why this quantity: sales the order can't cover (out of stock before it arrives) are taken out; Sells when out of stock when it applies", () => {
    const t = (x: string) => x;
    const lost = { day: 0, days: 74, demand: 740, rate: 10, season: 1, growth: 1, safety: 50, onHand: 0, onOrder: 0, missed: 600, sellsWhenOut: false, need: 190, rounded: 190, pack: null, moq: null, topUp: 0 };
    expect(whyLines(lost, t, "en")).toEqual([
      "Forecast for the next 74 days: 740 (sales per day 10, season ×1) + safety 50 − on hand 0 − on order 0 − sales it can't cover (out of stock before it arrives) 600 = 190",
      "→ rounded to 190",
    ]);
    const owed = { ...lost, missed: 0, sellsWhenOut: true, need: 790, rounded: 790 };
    expect(whyLines(owed, t, "en")).toEqual([
      "Forecast for the next 74 days: 740 (sales per day 10, season ×1) + safety 50 − on hand 0 − on order 0 = 790",
      "Sells when out of stock: what it sells while out of stock is owed, so it is ordered back.",
      "→ rounded to 790",
    ]);
    expect(whyLines(lost, (x) => translate("fr", x), "fr")[0]).toContain("ventes qu'elle ne peut pas couvrir (rupture avant son arrivée) 600");
  });

  it("Why this quantity: a pace from older in-stock days says since when (out of stock most of the last 90 days)", () => {
    const t = (x: string) => x;
    const why = { day: 0, days: 28, demand: 84, rate: 3, season: 1, growth: 1, safety: 5, onHand: 0, onOrder: 0, need: 89, rounded: 89, pack: null, moq: null, topUp: 0, paceFrom: "2026-07-03" };
    expect(whyLines(why, t, "en")).toContain("Sales per day based on in-stock days since July 2026.");
    expect(whyLines(why, (x) => translate("de", x), "de")).toContain("Verkäufe pro Tag aus den Tagen mit Bestand seit Juli 2026.");
    expect(whyLines({ ...why, paceFrom: null }, t, "en").some((l) => l.includes("since"))).toBe(false);
  });

  it("last year's same weeks: the number, or — without history; a warning above 1.5×", () => {
    const t = (x: string) => x;
    expect(lastYearLine(40, t, "en")).toBe("Sold in the same weeks last year: 40");
    expect(lastYearLine(null, t, "en")).toBe("Sold in the same weeks last year: — (no history yet)");
    expect(aboveLastYear(61, 40)).toBe(true);
    expect(aboveLastYear(60, 40)).toBe(false);
    expect(aboveLastYear(61, null)).toBe(false);
  });

  it("the Free lock's numbers: products beyond the preview, suppliers, 13-week cash", () => {
    expect(lockTeaser(plan, 2)).toEqual({ more: 2, suppliers: 3, cash: cashOf(plan), missingCost: plan.events.filter((e) => e.cost === null).length });
    expect(lockTeaser(plan)).toBeNull(); // all four products are in the top 10
    expect(lockTeaser({ ...plan, events: [] })).toBeNull();
  });

  it("13 calendar weeks, on the Dashboard too (one cash horizon)", () => {
    expect(planWeeks(plan)).toHaveLength(13);
  });

  it("the Free preview: next order per variant, most urgent first, at most 10", () => {
    const rows = previewRows(plan);
    expect(rows[0]).toMatchObject({ productTitle: "Linen shirt", overdue: true, qty: 38 });
    // Overdue by more than one lead time: no date, the day it runs out as context (A1).
    expect(rows[0]).toMatchObject({ orderBy: null, dueNote: { runsOut: "2026-10-18" } });
    for (let i = 1; i < rows.length; i++) expect((rows[i - 1]!.orderBy ?? "") <= (rows[i]!.orderBy ?? "")).toBe(true);
    expect(previewRows(plan, 2)).toHaveLength(2);
  });

  it("links name the supplier and the order-by range (resolved on the server, never truncated)", () => {
    const e = (orderBy: string) => ({ orderBy, supplierKey: "supplier:s1" });
    expect(orderLink([e("2026-10-18"), e("2026-10-16"), e("2026-10-20")], "supplier:s1")).toBe("/app/reorder?supplier=supplier:s1&from=2026-10-16&to=2026-10-20");
    expect(orderLink([e("2026-10-18")])).toBe("/app/reorder?supplier=supplier:s1&from=2026-10-18&to=2026-10-18");
    expect(orderLink([])).toBe("/app/reorder");
  });

  it("names: supplier, vendor, or No vendor", () => {
    const t = (s: string) => s;
    expect(supplierName(plan, "supplier:s1", t)).toBe("Lisbon Linen");
    expect(supplierName(plan, "vendor:acme", t)).toBe("Acme");
    expect(supplierName(plan, "vendor:", t)).toBe("No vendor");
  });

  it("CSV: one row per line, unknown costs empty (never 0), headers translated", () => {
    const csv = planCsv(plan, (s) => translate("de", s));
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toContain("Bestellen bis");
    expect(lines).toHaveLength(plan.events.length + 1);
    const mug = lines.find((l) => l.includes("Mug"))!;
    expect(mug).toMatch(/,Acme,Mug,M,SKU-3,\d+,,,EUR$/);
  });

  it("week ranges in the admin language", () => {
    expect(formatWeekRange("2026-10-19", "en").replace(/\s/g, " ")).toBe("Oct 19 – 25");
    expect(formatWeekRange("2026-10-26", "de").replace(/\s/g, " ")).toBe("26. Okt. – 1. Nov.");
  });
});

describe("loaders: the plan gates on the server too", () => {
  const args = (url: string) => ({ request: new Request(url), params: {}, context: {} }) as never;
  const as = (plan: "free" | "growth" | "pro") => {
    vi.mocked(authenticate.admin).mockResolvedValue({ session: { shop: "acme.myshopify.com" } } as never);
    vi.mocked(getEntitlements).mockResolvedValue({ plan, features: featureMap(plan), comped: false, checked: true } as never);
    vi.mocked(loadOrderPlan).mockResolvedValue(orderPlanFixture());
  };

  it("Next 13 weeks: Growth loads the plan; Free gets only the teaching totals", async () => {
    as("growth");
    expect((await calendarLoader(args("https://app.test/app/reorder/calendar"))).plan.events.length).toBeGreaterThan(0);
    as("free");
    const free = await calendarLoader(args("https://app.test/app/reorder/calendar"));
    expect(free.enabled).toBe(false);
    // No order, product or variant reaches the browser — only the merchant's own totals.
    expect(free.plan.events).toEqual([]);
    expect(free.plan.variants).toEqual({});
    // Four products, all inside the Free top 10: nothing more to tease.
    expect(free.teaser).toBeNull();
  });

  it("CSV: Growth downloads the plan in the store language; Free gets the upgrade answer", async () => {
    as("growth");
    const res = (await csvLoader(args("https://app.test/app/reorder/calendar/csv"))) as Response;
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("order-plan-2026-10-16.csv");
    expect(await res.text()).toContain("Bestellen bis");
    as("free");
    expect(((await csvLoader(args("https://app.test/app/reorder/calendar/csv"))) as Response).status).toBe(403);
  });
});

describe("Next 13 weeks footnote names the trend only when the growth assumption is on (2026-10-17)", () => {
  it("off (default): sales pace, last year's season, stock and stock on order — no trend", () => {
    const html = render({ enabled: true, plan: orderPlanFixture() });
    expect(html).toContain("Based on sales per day while in stock, last year&#x27;s season, stock on hand and stock on order with its dates.");
    expect(html).not.toContain("the trend");
  });
  it("store: the trend is named", () => {
    const html = render({ enabled: true, plan: { ...orderPlanFixture(), trendMode: "store" } });
    expect(html).toContain("Based on sales per day while in stock, last year&#x27;s season, the trend, stock on hand and stock on order with its dates.");
  });
});
