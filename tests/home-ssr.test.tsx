/**
 * SSR: Home (task 1.6) in its four states — syncing (no Shop row yet),
 * ready (4 money cards, one null card shows "—"), not enough sales, no stock
 * tracked — plus the data-late banner, the Free refresh note and the setup guide.
 * Task 2.3: "This week's actions" — every tab and button, `?tab=`, Free
 * (top 10, Fix as a count, locked Bridge / Clear) vs Growth, and the empty state.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/services/entitlements.server", () => ({ planFor: vi.fn(), getEntitlements: vi.fn() }));
vi.mock("../app/models/dashboard.server", () => ({ getHomeData: vi.fn(), reviewAskDue: vi.fn(async () => null), readiness: vi.fn(async () => ({ ready: true })) }));
vi.mock("../app/models/settings.server", () => ({ recordReviewAsk: vi.fn(async () => true) }));
vi.mock("../app/models/actions.server", () => ({ getActionList: vi.fn() }));
vi.mock("../app/services/keha-preorder.server", () => ({ kehaPreorderInstalled: vi.fn() }));
vi.mock("../app/models/order-plan.server", () => ({ loadOrderPlan: vi.fn() }));

import Home, { action, loader, type HomeLoaderData } from "../app/routes/app._index";
import ActionsPage, { type ActionsPageData } from "../app/routes/app.actions";
import { orderPlanFixture } from "./order-plan-fixtures";
import { lockTeaser, planWeeks, previewRows } from "../app/lib/order-plan-shared";
import { cashTotals } from "../app/lib/engine/forward-plan-shared";
import { buildHome, formatAmount, type HomeRaw } from "../app/lib/dashboard-shared";
import type { PlanCode } from "../app/lib/plan-shared";
import type { ActionListView } from "../app/lib/action-list-shared";
import { actionList, homeRaw } from "./home-fixtures";
import { actionTabHref } from "../app/lib/briefing-shared";

const NOW = new Date("2026-10-16T10:00:00Z");

function render(data: HomeLoaderData, url = "/app") {
  const Stub = createRoutesStub([{ id: "home", path: "/app", Component: Home, loader: () => data }]);
  return renderToString(<Stub initialEntries={[url]} hydrationData={{ loaderData: { home: data } }} />);
}

const home = (raw: HomeRaw, plan: PlanCode = "growth") => render(buildHome(raw, plan, NOW));

/** The Actions page (0286): the whole list with its tabs. */
function renderActions(data: ActionsPageData, url = "/app/actions") {
  const Stub = createRoutesStub([{ id: "actions", path: "/app/actions", Component: ActionsPage, loader: () => data }]);
  return renderToString(<Stub initialEntries={[url]} hydrationData={{ loaderData: { actions: data } }} />);
}

/** Occurrences of a substring. */
const count = (html: string, s: string) => html.split(s).length - 1;

describe("Home", () => {
  it("syncing: no Shop row yet shows the sync screen with every stage waiting and no numbers", () => {
    const html = home({ shop: null, money: null, trackedVariants: 0, variantsWithCost: 0, salesDays: 0 });
    expect(html).toContain("Setting up your order plan");
    for (const label of ["Products", "Stock history", "Sales history", "Store visits", "Building your plan"]) expect(html).toContain(label);
    // Nothing read yet: each dataset says "Waiting to start" instead of an empty bar; only the overall bar.
    expect(count(html, "<s-progress")).toBe(1);
    expect(count(html, "Waiting to start")).toBe(4);
    expect(html).toContain("Starts when the history is read");
    expect(html).not.toContain("Money at stake");
    // Header: a quiet subtitle, never a lone dash.
    expect(html).toContain('heading="Dashboard"');
    expect(html).toContain("First sync in progress");
    expect(html).not.toContain("—</span></div>");
    // The order block waits for the sync.
    expect(html).toContain("Due this week");
    expect(html).toContain("Your order plan appears here once your products, stock and sales are read.");
    // …and how far the reading is (never "nothing to order").
    expect(html).toContain("Still reading your store: 0%.");
    expect(html).not.toContain("Nothing to order");
    expect(html).not.toContain("No orders needed");
    expect(html).toContain("Setup guide");
    // Owner 2026-10-17: the sync screen leads (with what to do meanwhile), then the setup guide, then the order block.
    expect(html).toContain("While you wait");
    expect(html.indexOf("Setting up your order plan")).toBeLessThan(html.indexOf("Setup guide"));
    expect(html.indexOf("Setup guide")).toBeLessThan(html.indexOf("Due this week"));
    // Suppliers step (Growth): what suppliers are for.
    expect(html).toContain("Add your suppliers&#x27; lead times and case packs — they set every order-by date.");
  });

  it("first sync: the real update time once any computation finished, before the first nightly", () => {
    const raw = homeRaw();
    raw.shop!.lastNightlyAt = null;
    const html = home(raw);
    expect(html).not.toContain("First sync in progress");
    expect(html).toContain("Updated Oct 15, 05:20"); // basis.computedAt 03:20Z in Madrid
    // Both known: the later one.
    const both = homeRaw();
    both.shop!.lastNightlyAt = new Date("2026-10-14T01:00:00Z");
    expect(home(both)).toContain("Updated Oct 15, 05:20");
    const none = homeRaw();
    none.shop!.lastNightlyAt = null;
    none.money = null;
    expect(home(none)).toContain("First sync in progress");
  });

  it("setup guide Suppliers step: Growth adds suppliers (done once one exists); Free sees the vendors found", () => {
    const growth = homeRaw();
    expect(home(growth)).toContain('href="/app/settings/suppliers"');
    growth.supplierCount = 3;
    const set = home(growth);
    expect(set).toContain("3 suppliers set up.");
    const free = homeRaw();
    free.vendorCount = 7;
    const fhtml = home(free, "free");
    expect(fhtml).toContain("Vendors found: 7");
    expect(fhtml).toContain("Add suppliers · Growth plan");
    expect(fhtml).toContain('href="/app/plans?upgrade=suppliers"');
  });

  it("ready: four cards from the latest row, a null card shows a dash, popovers end with 'Based on:'", () => {
    const html = home(homeRaw(), "free");
    expect(html).toContain("Money at stake");
    expect(html).toContain("Sales at risk (next 28 days)");
    expect(html).toContain("Lost sales (last 90 days)");
    expect(html).toContain("Cash tied up");
    expect(html).toContain("Sales missed on sold-out pages (last 30 days)");
    expect(html).toContain("€1,235");
    expect(html).toContain("€800");
    expect(html).toContain("€0"); // a real zero stays a zero
    expect(html).toContain('<span class="keha-money__figure">—</span>'); // lost90 is null
    expect(html).toContain("Not enough sales yet to advise");
    expect(count(html, "<s-popover")).toBe(4);
    expect(count(html, "Based on: ")).toBe(4);
    expect(html).toContain("Assumes stock on order arrives within 28 days");
    expect(html).toContain("Valued at retail price");
    // Free plan: weekly refresh with an upgrade link.
    expect(html).toContain("Refreshed weekly on Free");
    expect(html).toContain('href="/app/plans"');
    // Older months still loading: a compact sync card, and every number says what it is based on.
    expect(html).toContain("Still reading older months");
    expect(html).toContain("Based on the last 4 months so far"); // stock 4, sales 6 months in
    expect(count(html, "<s-progress")).toBe(4); // overall + stock, sales, visits
    expect(html.indexOf("Money at stake")).toBeLessThan(html.indexOf("Still reading older months"));
    // Header: store name + update time in the store's time zone (Madrid = UTC+2).
    expect(html).toContain('heading="Dashboard"');
    expect(html).toContain("Updated Oct 16, 06:10");
    expect(html).not.toContain("Data is late");
  });

  it("paid plans don't show the Free refresh note", () => {
    expect(home(homeRaw(), "growth")).not.toContain("Refreshed weekly on Free");
  });

  it("ready but nothing computed yet says so instead of inventing numbers", () => {
    const raw = homeRaw();
    raw.money = null;
    const html = home(raw);
    expect(html).toContain("Your first numbers are being calculated.");
    expect(html).not.toContain("<s-popover");
  });

  it("not enough sales: fewer than 14 days of sales", () => {
    const raw = homeRaw();
    raw.salesDays = 9;
    const html = home(raw);
    // 9 of 14 days: 5 more nights of sales from today (16 Oct in Madrid) → 21 Oct.
    expect(html).toContain("Your first order plan needs 14 days of sales — expected on Oct 21, 2026.");
    expect(html).not.toContain("Sales at risk (next 28 days)");
    // 2026-10-17 click-through (history still loading, setup not done): the not-enough-sales card,
    // then the setup guide, then the sync progress — never the setup guide at the bottom.
    const card = html.indexOf("Not enough sales yet to advise");
    const setup = html.indexOf("Setup guide");
    const progress = html.indexOf("Reading your store…");
    expect(html).not.toContain("Based on the last"); // no numbers shown, so no "Based on …" label
    expect(card).toBeGreaterThanOrEqual(0);
    expect(card).toBeLessThan(setup);
    expect(setup).toBeLessThan(progress);
    expect(count(html, "Setup guide")).toBe(1);
  });

  it("no stock tracked: catalog read but nothing tracked", () => {
    const raw = homeRaw();
    raw.trackedVariants = 0;
    raw.variantsWithCost = 0;
    const html = home(raw);
    expect(html).toContain("Turn on &#x27;Track quantity&#x27; for your products in Shopify.");
    expect(html).toContain('href="shopify://admin/products"');
    expect(html).not.toContain("Sales at risk (next 28 days)");
    expect(html.indexOf("Setup guide")).toBeLessThan(html.indexOf("Reading your store…"));
  });

  it("data late: banner when the last nightly run is older than 36 h", () => {
    const raw = homeRaw();
    raw.shop!.lastNightlyAt = new Date("2026-10-14T03:00:00Z");
    const html = home(raw);
    expect(html).toContain("Data is late — no action needed, we&#x27;re retrying.");
  });

  it("setup guide without an email provider: the Monday step points to Shopify Flow, never promises an email", () => {
    const raw = homeRaw();
    raw.emailProvider = false;
    raw.shop!.settings = { mondayEmail: { enabled: false, recipients: [] } };
    const html = home(raw);
    expect(html).toContain("Weekly summary");
    expect(html).toContain("Get it by email with Shopify Flow: “Weekly order plan ready”.");
    expect(html).toContain("How it works");
    expect(html).not.toContain("Every Monday at 08:00 to");
    expect(html).not.toContain("Off. Turn it on to get your numbers");
    // Nothing to switch on in Keha: the step doesn't hold the guide open.
    raw.shop!.settings = { leadTimeConfirmedAt: "2026-10-01T00:00:00Z", mondayEmail: { enabled: false, recipients: [] } };
    raw.variantsWithCost = 190;
    raw.supplierCount = 1;
    expect(home(raw)).not.toContain("Setup guide");
  });

  it("setup guide: steps ticked from real state, hidden when all four are done", () => {
    const html = home(homeRaw());
    expect(html).toContain("How long do your suppliers take?");
    expect(html).toContain("Product costs found for 50% of products");
    expect(html).toContain("Every Monday at 08:00 to the store owner");
    expect(html).toContain('href="/app/settings"');
    expect(html).toContain('target="_top"');

    const raw = homeRaw();
    raw.shop!.settings = { leadTimeConfirmedAt: "2026-10-01T00:00:00Z", mondayEmail: { enabled: true, recipients: ["ops@acme.test"] } };
    raw.variantsWithCost = 190;
    raw.supplierCount = 1;
    const done = home(raw);
    expect(done).not.toContain("Setup guide");

    raw.variantsWithCost = 100;
    const partial = home(raw);
    expect(partial).toContain("Every Monday at 08:00 to ops@acme.test");
    expect(partial).toContain("Done");
  });
});

describe("Actions page: this week's actions (task 2.3; its own page since 0286)", () => {
  const withActions = (_plan: PlanCode, actions: ActionListView | null, url?: string) =>
    renderActions({ readiness: { ready: true }, list: actions, timezone: "Europe/Madrid" }, url);

  it("Growth, All tab: every kind's row and button, € figures, the … menu, ranked by €", () => {
    const html = withActions("growth", actionList("growth"));
    expect(html).toContain("This week&#x27;s actions");
    for (const tab of ["All (8)", "Reorder (1)", "Stock gaps (1)", "Promote (1)", "Product issues (4)", "Clearance (1)"]) expect(html).toContain(tab);
    expect(html).toContain("€8,200");
    expect(html).toContain("€3,400");
    // Ranked by € across groups: Clear (8,200) first, Reorder (3,400) next.
    expect(html.indexOf("Clear Cardigan")).toBeLessThan(html.indexOf("Reorder Tee"));
    expect(html.indexOf("Reorder Tee")).toBeLessThan(html.indexOf("Returns Romper"));
    // The reason: raw key fallback filled with its params.
    expect(html).toContain("Runs out in 1 days");
    expect(html).toContain("S, M");
    // Buttons per kind (spec §7.7).
    expect(html).toContain("Add to purchase order");
    expect(html).not.toContain("Add to order plan");
    expect(html).toContain(`href="/app/reorder?variants=${encodeURIComponent("gid://shopify/ProductVariant/11,gid://shopify/ProductVariant/12")}"`);
    expect(html).toContain(">Collect back-in-stock sign-ups</s-button>");
    expect(html).toContain("How to promote");
    expect(html).toContain("See why");
    expect(html).toContain('href="/app/products/41"');
    expect(html).toContain("Reorder sizes");
    expect(html).toContain("Review product page");
    expect(html).toContain('href="shopify://admin/products/6"');
    expect(html).toContain("Review sizing and quality");
    expect(html).toContain("Create discount");
    // The … menu.
    expect(count(html, "<s-menu")).toBe(8);
    expect(html).toContain("Snooze 7 days");
    expect(html).toContain("Dismiss");
    // Done is in every row's menu, first (the endpoint takes op "done").
    expect(count(html, ">Mark as done</s-button>")).toBe(8);
    expect(html).toMatch(/<s-menu[^>]*><s-button>Mark as done<\/s-button><s-button>Snooze 7 days<\/s-button>/);
    expect(html).toContain(">Why this action<");
    // Keha Preorder isn't installed: never named or linked (Shopify 2.2.6).
    expect(html).not.toContain("keha-preorder");
    expect(html).not.toContain(">Take preorders<");
    // Nothing locked on Growth.
    expect(html).not.toContain("Product issues:");
    expect(html).not.toContain("more actions worth");
  });

  it("Growth with Keha Preorder installed: the bridge opens its pre-filled form top-level", () => {
    const html = withActions("growth", actionList("growth", { preorderInstalled: true }));
    expect(html).toContain(">Take preorders<");
    expect(html).toContain(
      'href="https://admin.shopify.com/store/acme/apps/keha-preorder/app/campaigns/new?variants=21%2C22&amp;trigger=stock&amp;ship=2026-11-02&amp;name=Bridge+Boots" target="_top"',
    );
    expect(html).not.toContain(">Collect back-in-stock sign-ups</s-button>");
  });

  it("?tab=clear opens the Clear tab with the clearances running and the cash freed", () => {
    const html = withActions("growth", actionList("growth"), "/app/actions?tab=clear");
    expect(html).toContain("Clear Cardigan");
    expect(html).not.toContain("Reorder Tee");
    expect(html).toContain('aria-selected="true" class="keha-tab keha-tab--active">Clearance (1)');
    expect(html).toContain("Active clearance discounts");
    expect(html).toContain("Old Overcoat");
    expect(html).toContain("Discount code CLEAR-7Q3K");
    expect(html).toContain("Ends Nov 15, 2026");
    expect(html).toContain("Cash recovered so far: €1,200");
    expect(html).toContain("Valued at retail price");
  });

  it("?tab=fix shows only Fix rows; an unknown tab falls back to All", () => {
    const fix = withActions("growth", actionList("growth"), "/app/actions?tab=fix");
    expect(fix).toContain("Falling Fleece");
    expect(fix).not.toContain("Clear Cardigan");
    expect(fix).not.toContain("Active clearance discounts");
    const junk = withActions("growth", actionList("growth"), "/app/actions?tab=nope");
    expect(junk).toContain("Clear Cardigan");
    expect(junk).toContain("Reorder Tee");
  });

  it("Free: top 10, Fix as a count, locked Bridge and Clear with an Upgrade link", () => {
    const html = withActions("free", actionList("free", { fillers: 12 }));
    expect(html).toContain("All (10)");
    expect(html).toContain("Product issues (4)");
    expect(count(html, 'role="listitem"')).toBe(10);
    // Fix rows are counted, not shown (and not sent: they aren't in the list).
    expect(html).toContain("Product issues: 4");
    expect(html).toContain("Upgrade to see them");
    for (const title of ["Falling Fleece", "Sizes Sneaker", "Page Poncho", "Returns Romper"]) expect(html).not.toContain(title);
    // Bridge and Clear stay, locked: disabled button, plan badge, upgrade link.
    expect(html).toContain("Bridge Boots");
    expect(html).toContain("Clear Cardigan");
    expect(html).toContain('<s-button disabled="true">Collect back-in-stock sign-ups</s-button>');
    expect(html).not.toContain("Bridge the gap");
    expect(html).toContain('<s-button disabled="true">Create discount</s-button>');
    expect(html).toContain("Growth plan");
    // No working sign-ups button on Free: the only one is the locked one above.
    expect(html.split(">Collect back-in-stock sign-ups</s-button>").length - 1).toBe(1);
    // The rows past the top 10 are counted.
    expect(html).toMatch(/6 more actions worth €[\d,]+ on the Growth plan/);
    expect(html).toContain('href="/app/plans"');
  });

  it("empty state when there is nothing to do", () => {
    const html = withActions("growth", actionList("growth", { empty: true }));
    expect(html).toContain("This week&#x27;s actions");
    expect(html).toContain("Nothing to do this week. We&#x27;ll tell you when something needs you.");
    expect(html).not.toContain('role="tablist"');
  });

  it("no order block numbers before the store is ready", () => {
    const raw = homeRaw();
    raw.salesDays = 3;
    const html = render({ ...buildHome(raw, "growth", NOW), orderPlan: { kind: "full", plan: orderPlanFixture() } });
    expect(html).not.toContain("Review order");
  });

  it("no action list before the store is ready", () => {
    const raw = homeRaw();
    raw.salesDays = 3;
    const html = render({ ...buildHome(raw, "growth", NOW), actions: actionList("growth") });
    expect(html).not.toContain("This week&#x27;s actions");
  });
});

describe("Dashboard: the top 5 actions (0286)", () => {
  it("shows the 5 biggest by money, no tabs, and links to the Actions page", () => {
    const html = render({ ...buildHome(homeRaw(), "growth", NOW), actions: actionList("growth") });
    expect(html).toContain("This week&#x27;s actions");
    expect(count(html, 'role="listitem"')).toBe(5);
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain('href="/app/actions"');
    expect(html).toMatch(/See all \d+ actions/);
    // Ranked: the biggest first.
    expect(html.indexOf("Clear Cardigan")).toBeLessThan(html.indexOf("Reorder Tee"));
    // Clearances running and the Fix upsell live on the Actions page.
    expect(html).not.toContain("Active clearance discounts");
  });
  it("tiles open the Actions page on their tab, never a #fragment on the Dashboard", () => {
    expect(actionTabHref("clear")).toBe("/app/actions?tab=clear");
    expect(actionTabHref("bridge")).not.toContain("#");
  });
});

describe("Dashboard: Order this week (Kanwar 2026-10-17)", () => {
  const ready = (plan: PlanCode = "growth") => buildHome(homeRaw(), plan, NOW);

  it("under 13 months of sales: a quiet 'Seasons: learning' badge next to the plan, never a banner (accuracy audit 2026-10-18)", () => {
    const read = (salesFrom: string) => {
      const raw = homeRaw();
      raw.shop!.backfillState = { startedAt: "2026-10-15T10:00:00Z", finishedAt: "2026-10-15T12:00:00Z", first90Ready: true, datasets: { sales: { done: 10, total: 10, doneThrough: salesFrom } } };
      return buildHome(raw, "growth", NOW);
    };
    const young = read("2026-01-01");
    expect(young.seasonsLearning).toBe(9);
    const html = render({ ...young, orderPlan: { kind: "full", plan: orderPlanFixture() } });
    expect(html).toContain("Seasonality: 9 of 13 months of history");
    expect(html).not.toMatch(/<s-banner[^>]*>[^<]*Seasonality:/);
    expect(html).not.toContain("Based on the last"); // the whole history is read
    // 13 months or more: nothing.
    expect(read("2025-09-01").seasonsLearning).toBeNull();
    expect(render({ ...read("2025-09-01"), orderPlan: { kind: "full", plan: orderPlanFixture() } })).not.toContain("Seasonality: ");
    // Still reading: the partial badge says it; no seasons line yet.
    expect(ready().seasonsLearning).toBeNull();
  });

  it("per supplier the products, units, cash, order-by date and Review order; one cash line (the bars are on Next 13 weeks, 0286)", () => {
    const html = render({ ...ready(), orderPlan: { kind: "full", plan: orderPlanFixture() } });
    // 0286: the money at stake sits in the summary at the top; the order block follows it.
    expect(html.indexOf("Money at stake")).toBeLessThan(html.indexOf("Due this week"));
    expect(html).toContain("Lisbon Linen");
    expect(html).toContain("Overdue");
    expect(html).toContain("Review order");
    // Review order → Order now with that supplier's orders of the next 7 days (a key, never a list of variants).
    expect(html).toContain('href="/app/reorder?supplier=supplier:s1&amp;from=2026-10-16&amp;to=2026-10-17"');
    expect(html).toMatch(/[\d,]+ units from 1 supplier · €[\d,]+/);
    expect(html).toMatch(/Cash needed, next 13 weeks: €[\d,]+/);
    expect(html).not.toContain("keha-orderplan-strip");
    expect(html).toContain('href="/app/reorder/calendar"');
    expect(html).toContain("12 products can&#x27;t be planned yet — not enough sales history.");
  });

  it("one cash horizon: the Dashboard strip shows the same 13 weeks and the same total as Next 13 weeks", () => {
    const fx = orderPlanFixture();
    const html = render({ ...ready(), orderPlan: { kind: "full", plan: fx } });
    // Next 13 weeks' summary total (app.reorder_.calendar: cashTotals of every planned order).
    const total = cashTotals(fx.events).cash!;
    const shown = formatAmount(total, fx.currency, "en");
    expect(html).toContain(`Cash needed, next 13 weeks: ${shown}`);
    // 13 week columns in the strip, as on the calendar.
    expect(planWeeks(fx)).toHaveLength(13);
    expect(html).not.toMatch(/next 12 weeks|next 90 days/i);
  });

  it("nothing due this week: names the next order; nothing at all: says so", () => {
    const fx = orderPlanFixture();
    const later = { ...fx, events: fx.events.filter((e) => e.orderBy > "2026-10-22") };
    const next = render({ ...ready(), orderPlan: { kind: "full", plan: later } });
    expect(next).toMatch(/Nothing to order this week\. Next order: (Lisbon Linen|Cap Co|Acme) by [A-Z][a-z]{2} \d+, 2026\./);
    const none = render({ ...ready(), orderPlan: { kind: "full", plan: { ...fx, events: [] } } });
    expect(none).toContain("No orders needed in the next 13 weeks.");
    expect(none).not.toContain("keha-orderplan-strip");
  });

  it("no suppliers yet: still grouped (by vendor), with a one-line nudge to Settings → Suppliers", () => {
    const html = render({ ...ready(), orderPlan: { kind: "full", plan: orderPlanFixture({ suppliersSetUp: false }) } });
    expect(html).toContain("Grouped by vendor until you add your suppliers.");
    expect(html).toContain('href="/app/settings/suppliers"');
    expect(html).toContain("Review order");
  });

  it("Free: the read-only top 10 and the teaching lock — no suppliers, buttons or calendar", () => {
    const rows = previewRows(orderPlanFixture());
    const html = render({ ...ready("free"), orderPlan: { kind: "preview", rows } });
    expect(html).toContain("Linen shirt");
    expect(html).toContain("Group by supplier, send purchase orders, see the next 13 weeks");
    expect(html).not.toContain("Review order");
    expect(html).not.toContain("keha-orderplan-strip");
    expect(html).not.toContain("Lisbon Linen");
  });

  it("Free: the teaching lock shows the merchant's own totals (lockTeaser)", () => {
    const rows = previewRows(orderPlanFixture());
    const html = render({ ...ready("free"), orderPlan: { kind: "preview", rows, teaser: { more: 14, suppliers: 3, cash: 4200, missingCost: 0 }, currency: "EUR" } });
    expect(html).toContain("Your plan has 14 more products to order from 3 suppliers — €4,200 over the next 13 weeks.");
    // No teaser (nothing beyond the top 10): just the lock.
    expect(render({ ...ready("free"), orderPlan: { kind: "preview", rows, teaser: null } })).not.toContain("Your plan has");
  });
});

describe("Dashboard loader", () => {
  it("Growth and Pro get the whole plan; Free only the top-10 preview", async () => {
    const { authenticate } = await import("../app/shopify.server");
    const ent = await import("../app/services/entitlements.server");
    const dash = await import("../app/models/dashboard.server");
    const acts = await import("../app/models/actions.server");
    const op = await import("../app/models/order-plan.server");
    vi.mocked(authenticate.admin).mockResolvedValue({ admin: {}, session: { shop: "acme.myshopify.com" } } as never);
    vi.mocked(dash.getHomeData).mockResolvedValue(buildHome(homeRaw(), "growth", NOW));
    vi.mocked(acts.getActionList).mockResolvedValue(null as never);
    vi.mocked(op.loadOrderPlan).mockResolvedValue(orderPlanFixture());
    const args = { request: new Request("https://app.test/app"), params: {}, context: {} } as never;
    vi.mocked(ent.planFor).mockResolvedValue("growth");
    expect((await loader(args)).orderPlan?.kind).toBe("full");
    // planFor fails open to Pro when the plan check fails (entitlements.server).
    vi.mocked(ent.planFor).mockResolvedValue("pro");
    expect((await loader(args)).orderPlan?.kind).toBe("full");
    vi.mocked(ent.planFor).mockResolvedValue("free");
    const free = await loader(args);
    expect(free.orderPlan).toMatchObject({ kind: "preview", teaser: lockTeaser(orderPlanFixture()), currency: orderPlanFixture().currency });
    expect((free.orderPlan as { rows: unknown[] }).rows.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(free)).not.toContain("Lisbon Linen");
  });
});

describe("Dashboard: review request after a success moment", () => {
  const args = (body?: unknown) =>
    ({
      request: body
        ? new Request("https://app.test/app?index", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        : new Request("https://app.test/app"),
      params: {},
      context: {},
    }) as never;

  it("the loader passes the moment through; the page shows nothing of its own (Shopify's modal only)", async () => {
    const { authenticate } = await import("../app/shopify.server");
    const ent = await import("../app/services/entitlements.server");
    const dash = await import("../app/models/dashboard.server");
    const acts = await import("../app/models/actions.server");
    const op = await import("../app/models/order-plan.server");
    vi.mocked(authenticate.admin).mockResolvedValue({ admin: {}, session: { shop: "acme.myshopify.com" } } as never);
    vi.mocked(ent.planFor).mockResolvedValue("growth");
    vi.mocked(dash.getHomeData).mockResolvedValue(buildHome(homeRaw(), "growth", NOW));
    vi.mocked(acts.getActionList).mockResolvedValue(null as never);
    vi.mocked(op.loadOrderPlan).mockResolvedValue(orderPlanFixture());
    vi.mocked(dash.reviewAskDue).mockResolvedValueOnce("supplier_confirmed");
    const data = await loader(args());
    expect(data.reviewAsk).toBe("supplier_confirmed");
    // A failing check never breaks the Dashboard.
    vi.mocked(dash.reviewAskDue).mockRejectedValueOnce(new Error("db"));
    expect((await loader(args())).reviewAsk).toBeNull();
    const html = render({ ...buildHome(homeRaw(), "growth", NOW), reviewAsk: "accuracy" });
    expect(html).not.toMatch(/review/i);
  });

  it("records only final answers (shown, already reviewed, limits), never twice", async () => {
    const { authenticate } = await import("../app/shopify.server");
    const settings = await import("../app/models/settings.server");
    vi.mocked(authenticate.admin).mockResolvedValue({ admin: {}, session: { shop: "acme.myshopify.com" } } as never);
    vi.mocked(settings.recordReviewAsk).mockClear();
    expect(await action(args({ intent: "reviewAsked", code: "success" }))).toEqual({ ok: true });
    expect(settings.recordReviewAsk).toHaveBeenCalledWith("acme.myshopify.com", "success", expect.any(Date));
    for (const code of ["mobile-app", "cancelled", "recently-installed", "open-in-progress", "nope"])
      expect(await action(args({ intent: "reviewAsked", code }))).toEqual({ ok: false });
    expect(await action(args({ intent: "other", code: "success" }))).toEqual({ ok: false });
    expect(settings.recordReviewAsk).toHaveBeenCalledTimes(1);
  });
});

describe("weekly sales re-check line (owner 2026-10-18)", () => {
  const withRecheck = (over: Record<string, unknown>) => {
    const raw = homeRaw();
    raw.shop!.backfillState = {
      ...(raw.shop!.backfillState as object),
      weeklyRecheck: { at: "2026-10-15T04:00:00.000Z", outcome: "done", since: "2026-09-10", until: "2026-10-14", differing: 3, corrected: 3, unitsBefore: 1000, unitsAfter: 970, changed: 30, share: 0.03, ...over },
    };
    return raw;
  };

  it("corrections above 2% of the window's units: one quiet line under the money cards", () => {
    const html = home(withRecheck({}));
    expect(html).toContain("Shopify updated 3 days of past sales (refunds or order edits). Your numbers include them.");
    expect(html.indexOf("Numbers from")).toBeLessThan(html.indexOf("Shopify updated 3 days"));
  });

  it("2% or less, nothing corrected, or older than 8 days: nothing shown", () => {
    expect(home(withRecheck({ share: 0.02, changed: 20 }))).not.toContain("Shopify updated");
    expect(home(withRecheck({ corrected: 0, share: 0 }))).not.toContain("Shopify updated");
    expect(home(withRecheck({ at: "2026-10-07T00:00:00.000Z" }))).not.toContain("Shopify updated");
    expect(home(homeRaw())).not.toContain("Shopify updated");
  });

  it("one corrected day: singular", () => {
    const data = buildHome(withRecheck({ corrected: 1, differing: 1 }), "growth", NOW);
    expect(home(withRecheck({ corrected: 1 }))).toContain("Shopify updated 1 day of past sales (refunds or order edits). Your numbers include it.");
    expect(data.recheckNotice).toEqual({ corrected: 1 });
  });
});

describe("Sample data: no link into the Shopify admin (0286, live 404)", () => {
  it("Review product page / sizing open Keha's Products list instead", async () => {
    const { SampleProvider } = await import("../app/components/sample");
    const data: ActionsPageData = { readiness: { ready: true }, list: actionList("growth"), timezone: "Europe/Madrid" };
    const Wrapped = () => (
      <SampleProvider value={{ on: true }}>
        <ActionsPage />
      </SampleProvider>
    );
    const Stub = createRoutesStub([{ id: "actions", path: "/app/actions", Component: Wrapped, loader: () => data }]);
    const html = renderToString(<Stub initialEntries={["/app/actions"]} hydrationData={{ loaderData: { actions: data } }} />);
    expect(html).toContain("Review product page");
    expect(html).not.toContain("shopify://admin/products/");
    expect(html).toMatch(/href="\/app\/products\?q=[^"]+"/);
  });
});
