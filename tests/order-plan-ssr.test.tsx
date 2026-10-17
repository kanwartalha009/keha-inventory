/**
 * Order plan (Kanwar 2026-10-17): Next 90 days (Growth / Free / empty), the shared helpers
 * (Order this week, the Free preview, links, CSV) on a plan built with the real forward plan.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
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
import { EMPTY_ORDER_PLAN, formatWeekRange, orderLink, planCsv, planWeeks, previewRows, supplierName, thisWeek } from "../app/lib/order-plan-shared";
import { translate } from "../app/lib/i18n";
import { PLAN_TODAY, orderPlanFixture } from "./order-plan-fixtures";

function render(data: CalendarPageData) {
  const Stub = createRoutesStub([{ id: "cal", path: "/app/reorder/calendar", Component: OrderCalendar, loader: () => data }]);
  return renderToString(<Stub initialEntries={["/app/reorder/calendar"]} hydrationData={{ loaderData: { cal: data } }} />);
}

describe("Next 90 days", () => {
  it("Growth: summary, cash strip, 13 week rows, the first busy week open with its suppliers and lines", () => {
    const html = render({ enabled: true, plan: orderPlanFixture() });
    expect(html).toMatch(/aria-selected="true" class="keha-tab keha-tab--active">Next 90 days</);
    expect(html).toMatch(/\d+ orders in the next 13 weeks · [\d,]+ units · €[\d,]+/);
    expect(html).toContain("keha-orderplan-strip");
    expect(html.split("keha-orderplan-week ").length - 1 + (html.split("keha-orderplan-week\"").length - 1)).toBe(13);
    expect(html).toMatch(/Oct 12\s–\s18/); // this ISO week (Intl uses thin spaces)
    expect(html).toContain("Overdue");
    expect(html).toContain("Lisbon Linen");
    expect(html).toContain("Create order");
    // Create order → Order now with the lines at their planned quantities, that supplier only.
    expect(html).toMatch(/href="\/app\/reorder\?variants=1:61,2:\d+&amp;supplier=supplier:s1"/);
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
    expect(html).toContain("No orders needed in the next 90 days.");
    expect(html).not.toContain("Download CSV");
    expect(html).not.toContain("Week by week");
  });

  it("Free (and below Growth): the tab bar stays and the tab teaches", () => {
    const html = render({ enabled: false, plan: EMPTY_ORDER_PLAN("") });
    expect(html).toContain("keha-tabs");
    expect(html).toContain("90-day order calendar · Growth plan");
    expect(html).toContain('href="/app/plans?upgrade=orderCalendar"');
    expect(html).not.toContain("Download CSV");
  });
});

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

  it("13 calendar weeks, 12 on the Dashboard", () => {
    expect(planWeeks(plan)).toHaveLength(13);
    expect(planWeeks(plan, 12)).toHaveLength(12);
  });

  it("the Free preview: next order per variant, most urgent first, at most 10", () => {
    const rows = previewRows(plan);
    expect(rows[0]).toMatchObject({ productTitle: "Linen shirt", overdue: true, qty: 61 });
    expect(rows[0]!.orderBy < PLAN_TODAY).toBe(true); // overdue shows its order-by date
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.orderBy <= rows[i]!.orderBy).toBe(true);
    expect(previewRows(plan, 2)).toHaveLength(2);
  });

  it("links sum one variant's orders and keep the supplier", () => {
    const e = (n: number, qty: number) => ({ variantId: `gid://shopify/ProductVariant/${n}`, qty, supplierKey: "supplier:s1" });
    expect(orderLink([e(1, 5), e(2, 3), e(1, 4)], "supplier:s1")).toBe("/app/reorder?variants=1:9,2:3&supplier=supplier:s1");
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

  it("Next 90 days: Growth loads the plan; Free gets nothing", async () => {
    as("growth");
    expect((await calendarLoader(args("https://app.test/app/reorder/calendar"))).plan.events.length).toBeGreaterThan(0);
    as("free");
    vi.mocked(loadOrderPlan).mockClear();
    const free = await calendarLoader(args("https://app.test/app/reorder/calendar"));
    expect(free.enabled).toBe(false);
    expect(free.plan.events).toEqual([]);
    expect(loadOrderPlan).not.toHaveBeenCalled();
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
