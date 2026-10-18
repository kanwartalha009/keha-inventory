/**
 * SSR: the supplier order builder (/app/reorder/build; consolidated supplier purchase order,
 * Kanwar 2026-10-17) on Growth and Free, in English and German, its loader and action plan
 * checks, and its entry points on Order now ("Build purchase order" on each supplier card, inside
 * "Can join this order" when there is one) and Next 13 weeks (per supplier-week).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() }, unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/services/entitlements.server", () => ({ getEntitlements: vi.fn(), upgradeResponse: vi.fn(() => new Response("upgrade", { status: 403 })) }));
vi.mock("../app/models/supplier-order.server", async () => {
  const { orderNowFixture } = await import("./order-plan-fixtures");
  const { buildSupplierOrder } = await import("../app/lib/supplier-order-shared");
  const plan = orderNowFixture({ minOrderTotal: null });
  return {
    loadSupplierOrder: vi.fn(async (_shop: string, key: string) =>
      key === "supplier:s1" ? { view: buildSupplierOrder({ plan, supplierKey: key, info: { ...plan.suppliers[key]!, orderCycleDays: 30 }, storeCycleDays: 14 }), today: plan.today } : null,
    ),
    createSupplierDraft: vi.fn(async () => ({ ok: true, id: "po9", number: "PO-0009" })),
    addToSupplierDraft: vi.fn(async () => ({ ok: true, id: "d1", number: "PO-0007", added: true })),
    searchSupplierProducts: vi.fn(async () => []),
  };
});

import Builder, { action as builderAction, loader as builderLoader, shouldRevalidate, type BuilderPageData } from "../app/routes/app.reorder_.build";
import Reorder, { type ReorderPageData } from "../app/routes/app.reorder";
import OrderCalendar from "../app/routes/app.reorder_.calendar";
import { authenticate } from "../app/shopify.server";
import { getEntitlements, upgradeResponse } from "../app/services/entitlements.server";
import { createSupplierDraft } from "../app/models/supplier-order.server";
import { featureMap, lockedPageFeature } from "../app/lib/plan-shared";
import { LocaleProvider, fill, translate } from "../app/lib/i18n";
import { buildOrderNow } from "../app/lib/reorder-shared";
import { buildSupplierOrder, builderTeaser, type SupplierOrderView } from "../app/lib/supplier-order-shared";
import { orderNowFixture, orderPlanFixture } from "./order-plan-fixtures";

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const KEY = "supplier:s1";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(path: string, id: string, Component: React.ComponentType, data: unknown) {
  const Stub = createRoutesStub([{ id, path: path.split("?")[0]!, Component, loader: () => data }]);
  return renderToString(<Stub initialEntries={[path]} hydrationData={{ loaderData: { [id]: data } }} />);
}

function view(over: { minOrderTotal?: number | null; orderCycleDays?: number | null } = {}, draft: SupplierOrderView["draft"] = null): SupplierOrderView {
  const plan = orderNowFixture({ minOrderTotal: over.minOrderTotal ?? null });
  return buildSupplierOrder({
    plan,
    supplierKey: KEY,
    info: { ...plan.suppliers[KEY]!, minOrderTotal: over.minOrderTotal ?? null, orderCycleDays: over.orderCycleDays === undefined ? 30 : over.orderCycleDays },
    storeCycleDays: 14,
    draft,
  });
}

const growth = (v: SupplierOrderView | null): BuilderPageData => ({ enabled: true, view: v, today: "2026-10-16" });
const page = (data: BuilderPageData, Component: React.ComponentType = Builder) => render(`/app/reorder/build?supplier=${KEY}`, "build", Component, data);

describe("Supplier order builder (Growth)", () => {
  it("due now, due before the next order with their own dates, live totals, Why this quantity, Create draft order in the title bar", () => {
    const html = page(growth(view()));
    expect(html).toContain('heading="Order from Acme Textiles"');
    expect(html).toMatch(/slot="breadcrumb-actions"[^>]*>Due now</);
    expect(html).toMatch(/<s-button[^>]*slot="primary-action"[^>]*>Create purchase order</);
    expect(html).toContain("Due now");
    expect(html).toContain("Orders due in the next 7 days, overdue ones included.");
    expect(html).toContain("Due before your next order");
    expect(html).toContain("Due by Nov 14, 2026. Order them now and send one order instead of several.");
    // The supplier's cycle, where it comes from, and the way to change it.
    expect(html).toContain("30 days (supplier)");
    expect(html).toContain('href="/app/settings/suppliers?edit=s1"');
    expect(html).toContain("Overdue · runs out Oct 18");
    expect(html).toContain("Due Oct 24");
    expect(html).toContain("Why this quantity");
    // Several orders of one product in the cycle are added together, and said so.
    expect(html).toContain("Orders due in the next 30 days (2), added together:");
    const units = view().lines.reduce((a, l) => a + l.suggested, 0);
    expect(html).toContain(`Units: ${units}`);
    expect(html).toMatch(/Cost: €[\d.,]+/);
    expect(html).toContain("1 line without a cost price");
    // Every line starts selected; Add products is there; no draft → no "Add to".
    expect((html.match(/<s-checkbox[^>]*checked/g) ?? []).length).toBe(view().lines.length);
    expect(html).toContain("Add products");
    expect(html).toContain("Any product from Acme Textiles, at any quantity.");
    expect(html).not.toContain("Add to PO-");
    // DESIGN-RULES: numbers right-aligned, headers don't wrap.
    expect((html.match(/format="numeric"/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("the minimum: reached at the start; below it, what is missing and the one-click top-up", () => {
    // The store's 14-day cycle: this week's lines and the sock need a top-up to reach 200.
    const met = page(growth(view({ minOrderTotal: 200, orderCycleDays: null })));
    expect(met).toContain("Minimum reached");
    expect(met).toContain(esc("Acme Textiles's minimums: 200 per order."));
    expect(met).toMatch(/\+\d+ to reach the minimum/);
    expect(met).not.toContain("Top up to the minimum");
    const v = view({ minOrderTotal: 200, orderCycleDays: null });
    const below = page(growth({ ...v, minOrderTotal: 999 }));
    expect(below).toContain("Below the minimum");
    expect(below).toMatch(new RegExp(esc("Add \\d+ units to reach Acme Textiles's minimum of 999 units.")));
    expect(below).toContain("Top up to the minimum");
  });

  it("a fresh draft for the supplier: the banner and 'Add to PO-0007' next to Create draft order", () => {
    const html = page(growth(view({}, { id: "d1", number: "PO-0007", units: 40, createdAt: "2026-10-14T10:00:00Z", updatedAt: "2026-10-14T10:00:00Z" })));
    expect(html).toContain("PO-0007 is already a draft for Acme Textiles (40 units, created Oct 14, 2026). Add these lines to it, or create a new draft.");
    expect(html).toMatch(/<s-button[^>]*slot="secondary-actions"[^>]*>Add to PO-0007</);
    expect(html).toContain('href="/app/reorder/d1"');
  });

  it("nothing due: says so and keeps Add products; an unknown supplier says it's gone", () => {
    const empty = { ...view(), lines: [] };
    const html = page(growth(empty));
    expect(html).toContain("Nothing is due from Acme Textiles before Nov 14, 2026. Add products to order anyway.");
    expect(html).toContain("Add products");
    expect(page(growth(null))).toContain(esc("This supplier doesn't exist any more. Reload the page."));
  });

  it("German: the builder's strings are translated", () => {
    const German = () => (
      <LocaleProvider defaultLocale="de">
        <Builder />
      </LocaleProvider>
    );
    const html = page(growth(view({ minOrderTotal: 200 })), German);
    for (const k of ["Create purchase order", "Due now", "Due before your next order", "Add products", "Minimum reached", "Order every", "This order"]) {
      expect(translate("de", k), k).not.toBe(k);
      expect(html, k).toContain(esc(translate("de", k)));
    }
    expect(html).toContain(esc(fill(translate("de", "Order from {supplier}"), { supplier: "Acme Textiles" })));
  });
});

describe("Supplier order builder (Free): the teaching lock with the supplier's own numbers", () => {
  it("what it does, the numbers, See plans — no lines", () => {
    const teaser = builderTeaser(view());
    const html = page({ enabled: false, teaser });
    expect(html).toContain("Build purchase order · Growth plan");
    expect(html).toContain(`Acme Textiles: 3 products to order in the next 30 days — ${teaser.units} units`);
    expect(html).toContain('href="/app/plans?upgrade=reorderPlan"');
    expect(html).not.toContain("Linen shirt");
    expect(html).not.toContain("Create purchase order");
    const de = render(`/app/reorder/build?supplier=${KEY}`, "build", () => (
      <LocaleProvider defaultLocale="de">
        <Builder />
      </LocaleProvider>
    ), { enabled: false, teaser });
    expect(de).toContain(esc(translate("de", "Pick a supplier and get one purchase order with everything due before your next order to it, topped up to its minimums.")));
  });

  it("the page gates itself (not the plan page), the loader sends no lines, every action is refused", async () => {
    expect(lockedPageFeature("/app/reorder/build", "free")).toBeNull();
    expect(lockedPageFeature("/app/reorder/build/", "none")).toBeNull();
    vi.mocked(authenticate.admin).mockResolvedValue({ session: { shop: "acme.myshopify.com" } } as never);
    vi.mocked(getEntitlements).mockResolvedValue({ plan: "free", features: featureMap("free"), comped: false, checked: true } as never);
    const req = new Request(`https://x/app/reorder/build?supplier=${KEY}`);
    const free = (await builderLoader({ request: req, params: {}, context: {} } as never)) as BuilderPageData;
    expect(free.enabled).toBe(false);
    expect(JSON.stringify(free)).not.toContain("Linen shirt");
    expect(free).toMatchObject({ teaser: { name: "Acme Textiles", products: 3 } });
    const post = () =>
      builderAction({
        request: new Request("https://x/app/reorder/build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: "create", supplier: KEY, quantities: { [V(1)]: 6 } }) }),
        params: {},
        context: {},
      } as never);
    await post();
    expect(upgradeResponse).toHaveBeenCalledWith("reorderPlan", expect.any(String));
    expect(createSupplierDraft).not.toHaveBeenCalled();
    // Growth: the view, and the create goes to the model with whole quantities only.
    vi.mocked(getEntitlements).mockResolvedValue({ plan: "growth", features: featureMap("growth"), comped: false, checked: true } as never);
    const g = (await builderLoader({ request: req, params: {}, context: {} } as never)) as BuilderPageData;
    expect(g.enabled && g.view?.key).toBe(KEY);
    expect(await post()).toEqual({ ok: true, id: "po9", number: "PO-0009" });
    // Ship-to and the note (merchant audit 2026-10-18) go to the model as sent; it checks them.
    expect(createSupplierDraft).toHaveBeenCalledWith("acme.myshopify.com", KEY, { [V(1)]: 6 }, { shipTo: undefined, note: undefined });
    expect(shouldRevalidate({ actionResult: { ok: true, id: "po9", number: "PO-0009" }, defaultShouldRevalidate: true } as never)).toBe(false);
    expect(shouldRevalidate({ actionResult: { ok: false, error: "changed" }, defaultShouldRevalidate: true } as never)).toBe(true);
  });
});

describe("entry points", () => {
  function orderNow(): ReorderPageData {
    const plan = orderNowFixture({ minOrderTotal: null });
    return {
      enabled: true,
      locationsEnabled: false,
      locations: [],
      location: null,
      transfers: { enabled: false, groups: [], recent: [], hasWarehouse: false, hasStore: false },
      groups: buildOrderNow({ plan, stock: new Map(), onOrder: new Map() }),
      currency: "EUR",
      missingSelected: 0,
      today: plan.today,
      openOrders: [],
    };
  }

  it("Order now: one 'Build supplier order' per supplier card — inside 'Can join this order' when it is there", () => {
    const html = render("/app/reorder", "reorder", Reorder, orderNow());
    expect((html.match(/>Build purchase order</g) ?? []).length).toBe(2);
    expect(html).toContain('href="/app/reorder/build?supplier=supplier:s1"');
    expect(html).toContain('href="/app/reorder/build?supplier=vendor:beta"');
    const join = html.slice(html.indexOf("Due before next order"));
    expect(join.indexOf('href="/app/reorder/build?supplier=supplier:s1"')).toBeGreaterThan(-1);
    expect(join.indexOf('href="/app/reorder/build?supplier=supplier:s1"')).toBeLessThan(join.indexOf("</s-box>"));
  });

  it("Next 13 weeks: each supplier-week opens the builder for that week", () => {
    const html = render("/app/reorder/calendar", "cal", OrderCalendar, { enabled: true, plan: orderPlanFixture() });
    expect(html).toMatch(/href="\/app\/reorder\/build\?supplier=supplier:s1&amp;from=\d{4}-\d{2}-\d{2}&amp;to=\d{4}-\d{2}-\d{2}"/);
    expect(html).toContain("Build purchase order");
  });
});
