/**
 * SSR (task 2.5): the Planner page — a Growth store with a calculated scenario, the scenario
 * limit's teaching state, Pro with several scenarios, the scenario form, Free's locked page,
 * collection goals and the accuracy scorecard (empty + filled).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() }, unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/services/entitlements.server", () => ({ getEntitlements: vi.fn(), upgradeResponse: vi.fn() }));

import Planner from "../app/routes/app.reorder_.season";
import type { PlannerData, ScenarioView } from "../app/models/planner.server";
import { addDays } from "../app/lib/engine/dates-shared";
import { computeScenario, createPlannerSeason, newScenarioForm, type PlannerVariant } from "../app/lib/planner-shared";

function render(path: string, data: unknown) {
  const Stub = createRoutesStub([{ id: "planner", path: "/app/reorder/season", Component: Planner, loader: () => data }]);
  return renderToString(<Stub initialEntries={[path]} hydrationData={{ loaderData: { planner: data } }} />);
}

const TODAY = "2026-10-16";
const SHORT = { from: "2026-06-01", to: "2026-10-15" };
const units = new Map<string, number>();
for (let d = SHORT.from; d <= SHORT.to; d = addDays(d, 1)) units.set(d, 10);

const V = (n: number, over: Partial<PlannerVariant> = {}): PlannerVariant => ({
  id: `gid://shopify/ProductVariant/${n}`,
  productId: `gid://shopify/Product/${n}`,
  productTitle: `Shirt ${n}`,
  variantTitle: "M",
  sku: `SKU-${n}`,
  image: null,
  vendor: "Acme",
  supplierId: null,
  collections: ["gid://shopify/Collection/1"],
  caseQty: null,
  cost: 4,
  costCurrency: "EUR",
  price: 20,
  rate: 2,
  sigma: 1,
  z: 1.65,
  enoughData: true,
  onHand: 0,
  incoming: 0,
  ...over,
});

function result() {
  const start = "2026-11-26";
  const end = "2026-11-30";
  return computeScenario({
    today: TODAY,
    start,
    end,
    targetType: "growth",
    targetValue: 20,
    currency: "EUR",
    defaultLeadTimeDays: 14,
    variants: [V(1, { supplierId: "s1" }), V(2, { cost: null, collections: ["gid://shopify/Collection/1", "gid://shopify/Collection/2"] })],
    suppliers: [{ id: "s1", name: "Slow Mill", leadTimeDays: 60, minOrder: null, minOrderTotal: null, casePack: null, vendorMatch: [], currency: null }],
    season: createPlannerSeason({ today: TODAY, start, end, store: { units, coverage: SHORT } }),
    coverage: SHORT,
    lastYear: { from: "2025-11-26", to: "2025-11-30", units: null, revenue: null, coverage: 0 },
    computedAt: "2026-10-16T08:00:00.000Z",
  });
}

const scenario = (id: string, name: string): ScenarioView => ({
  id,
  name,
  event: "black_friday",
  start: "2026-11-26",
  end: "2026-11-30",
  targetType: "growth",
  targetValue: 20,
  computedAt: "2026-10-16T08:00:00.000Z",
});

function data(over: Partial<PlannerData> = {}): PlannerData {
  const s = scenario("sc1", "Black Friday 2026");
  return {
    enabled: true,
    plan: "growth",
    features: { collectionGoals: true, accuracy: true },
    today: TODAY,
    timezone: "Europe/Madrid",
    currency: "EUR",
    history: { enough: false, from: SHORT.from },
    scenarios: [s],
    selected: { ...s, result: result() },
    canAdd: false,
    limit: 1,
    editing: null,
    collectionTitles: { "gid://shopify/Collection/1": "Summer", "gid://shopify/Collection/2": "Basics" },
    collectionOptions: [
      { id: "gid://shopify/Collection/1", title: "Summer" },
      { id: "gid://shopify/Collection/2", title: "Basics" },
    ],
    goals: { rows: [], total: 0, window: { from: "2026-07-18", to: "2026-10-15" } },
    scorecard: { kind: "empty", firstDate: "2026-12-01" },
    ...over,
  };
}

describe("Season plan: the trend is named only when the scenario used it", () => {
  it("growth assumption on: the trend line and both Based on lines include it", () => {
    const d = data();
    const result = d.selected!.result!;
    const on = { ...d, selected: { ...d.selected!, result: { ...result, season: { ...result.season, trendApplied: true, trend: 1.12 } } } };
    const html = render("/app/reorder/season", on);
    expect(html).toContain("Trend (last 28 days vs the same weeks last year): × 1.12");
    expect(html).toContain("Based on: sales per day while in stock × seasonal index × trend × plan × 5 days");
    expect(html).toContain("Based on: sales per day while in stock, seasonal index, trend, plan, stock now, incoming");
  });
});

describe("Planner page", () => {
  it("Growth with a scenario: summary, cash per week, order list, demand per collection, popovers", () => {
    const html = render("/app/reorder/season", data());
    // One of the Order plan tabs (Kanwar 2026-10-17): the tab bar, Season plan selected.
    expect(html).toContain('heading="Order plan"');
    for (const tab of ["Order now", "Next 13 weeks", "Season plan", "Open orders"]) expect(html).toContain(tab);
    expect(html).toMatch(/aria-selected="true" class="keha-tab keha-tab--active">Season plan</);
    expect(html).toContain("Based on the last 90 days only; we don&#x27;t have last year&#x27;s sales yet.");
    expect(html).toContain("Black Friday 2026");
    expect(html).toContain("Calculated Oct 16, 10:00 AM");
    expect(html).toContain("Recalculate");
    for (const h of ["Expected sales (units)", "Expected revenue", "Cash needed", "Last year, same period"]) expect(html).toContain(h);
    // Every number has a popover ending with "Based on: …".
    expect((html.match(/How we got this/g) ?? []).length).toBeGreaterThanOrEqual(6);
    // Growth assumption off (the default): the trend isn't used, so it isn't named (2026-10-17).
    expect(html).toContain("Based on: sales per day while in stock × seasonal index × plan × 5 days");
    expect(html).toContain("Based on: sales per day while in stock, seasonal index, plan, stock now, incoming");
    expect(html).not.toContain("Trend (last 28 days vs the same weeks last year)");
    expect(html).not.toMatch(/× trend ×|, trend, plan/);
    expect(html).toContain("Based on: units to order × unit cost from Shopify (retail price when the cost is missing)");
    // Chart with aria-label + table fallback.
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Cash needed per week from Oct 12, 2026 to Nov 2, 2026: €480 in total."/);
    expect(html).toContain("Week of");
    expect(html).toContain("Includes late orders");
    // Order list: supplier group, late flag, retail label, reorder link.
    expect(html).toContain("Slow Mill");
    expect(html).toContain("Late — order now");
    expect(html).toContain("at retail price");
    // Add to order: the saved scenario's quantities, read by Order now on the server (no 250-line cap).
    expect(html).toContain('href="/app/reorder?scenario=sc1"');
    expect(html).toContain("Add to order");
    expect(html).toContain("60 days (supplier)");
    // Demand per collection: overlap note, titles, store total; last year without data → "—".
    expect(html).toContain("collection totals overlap");
    expect(html).toContain("Summer");
    expect(html).toContain("Basics");
    expect(html).toContain("Whole store");
    expect(html).toContain("Not enough sales history for these dates yet.");
    // At the limit: teaching state, no create button.
    expect(html).toContain("Your plan keeps 1 scenario");
    expect(html).toContain("See plans");
    expect(html).not.toContain("New scenario");
  });

  it("Pro with several scenarios: all listed, create allowed, no limit banner", () => {
    const list = [scenario("a", "Black Friday 2026"), scenario("b", "Christmas 2026"), scenario("c", "Spring sale")];
    const html = render("/app/reorder/season?scenario=b", data({ plan: "pro", canAdd: true, limit: null, scenarios: list, selected: { ...list[1]!, result: null } }));
    for (const n of ["Black Friday 2026", "Christmas 2026", "Spring sale"]) expect(html).toContain(n);
    expect(html).toContain("New scenario");
    expect(html).not.toContain("Your plan keeps 1 scenario");
    expect(html).toContain("This scenario has no results yet. Recalculate to see them.");
    expect(html).toContain("Showing");
  });

  it("the scenario form: event, dates, target", () => {
    const html = render("/app/reorder/season?edit=new", data({ canAdd: true, editing: { id: null, form: newScenarioForm(TODAY) } }));
    for (const s of ["Scenario name", "Event", "Start date", "End date", "Target", "Growth vs. sales now", "Save and calculate", "Thursday to Cyber Monday."]) expect(html).toContain(s);
    expect(html).toContain('value="2026-11-26"');
    expect(html).toContain('value="2026-11-30"');
  });

  it("no scenarios yet: the empty state", () => {
    const html = render("/app/reorder/season", data({ scenarios: [], selected: null, canAdd: true }));
    expect(html).toContain("Plan your next season");
    expect(html).toContain("New scenario");
  });

  it("Free: the tab bar stays, the tab teaches (what it does + See plans)", () => {
    const html = render("/app/reorder/season", { ...data(), enabled: false, plan: "free" });
    expect(html).toContain("Season plan · Growth plan");
    expect(html).toContain("keha-tabs");
    expect(html).toContain('href="/app/plans?upgrade=planner"');
    expect(html).toContain("Plan a season or a growth target");
    expect(html).toContain("See plans");
    expect(html).not.toContain("Scenarios");
  });

  it("collection goals: share, gap, products holding it back, overlap note", () => {
    const html = render(
      "/app/reorder/season",
      data({
        goals: {
          total: 130,
          window: { from: "2026-07-18", to: "2026-10-15" },
          rows: [
            {
              collectionId: "gid://shopify/Collection/1",
              title: "Summer",
              goalPct: 60,
              actualShare: 0.3,
              revenue: 300,
              gapPts: 30,
              holdingBack: [{ productId: "p1", title: "Linen shirt", atRisk: 250, out: 1, low: 0 }],
            },
            { collectionId: "gid://shopify/Collection/2", title: null, goalPct: 70, actualShare: null, revenue: null, gapPts: null, holdingBack: [] },
          ],
        },
      }),
    );
    expect(html).toContain("Collection goals");
    expect(html).toContain("Your goals add up to 130%");
    expect(html).toContain("30 points below");
    expect(html).toContain("Linen shirt · €250 at risk · 1 out of stock");
    expect(html).toContain("Based on: gross sales in the last 90 days, all sales channels");
    expect(html).toContain("Save goal");
  });

  it("accuracy: empty state with the first date, then the graded month", () => {
    expect(render("/app/reorder/season", data())).toContain(
      "We grade our forecasts on the 1st of each month. Your first scorecard arrives on Dec 1, 2026.",
    );
    const html = render(
      "/app/reorder/season",
      data({
        scorecard: {
          kind: "graded",
          month: "2026-09-01",
          storeErrorPct: 12.5,
          top20ErrorPct: 18,
          graded: 2,
          rows: [
            { variantId: "v1", productTitle: "Linen shirt", variantTitle: "M", predicted: 20, actual: 16, errorPct: 25 },
            { variantId: "v2", productTitle: "Cap", variantTitle: "Default Title", predicted: 5, actual: 0, errorPct: null },
          ],
        },
      }),
    );
    expect(html).toContain("How accurate we were");
    expect(html).toContain("Graded month: September 2026");
    expect(html).toContain("12.5%");
    expect(html).toContain("18%");
    expect(html).toContain("Graded: 2");
    expect(html).toContain("Linen shirt");
    expect(html).toContain("25%");
  });

  it("plan without goals / accuracy: locked teaching sections", () => {
    const html = render("/app/reorder/season", data({ features: { collectionGoals: false, accuracy: false }, goals: null, scorecard: null }));
    expect(html).toContain("Set a revenue share per collection and see which products hold it back.");
    expect(html).toContain("Every month, see how close our forecasts were to what you actually sold.");
  });
});
