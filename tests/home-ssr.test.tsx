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
vi.mock("../app/models/dashboard.server", () => ({ getHomeData: vi.fn() }));
vi.mock("../app/models/actions.server", () => ({ getActionList: vi.fn() }));
vi.mock("../app/services/keha-preorder.server", () => ({ kehaPreorderInstalled: vi.fn() }));
vi.mock("../app/models/order-plan.server", () => ({ loadOrderPlan: vi.fn() }));

import Home, { loader, type HomeLoaderData } from "../app/routes/app._index";
import { orderPlanFixture } from "./order-plan-fixtures";
import { previewRows } from "../app/lib/order-plan-shared";
import { buildHome, type HomeRaw } from "../app/lib/dashboard-shared";
import type { PlanCode } from "../app/lib/plan-shared";
import type { ActionListView } from "../app/lib/action-list-shared";
import { actionList, homeRaw } from "./home-fixtures";

const NOW = new Date("2026-10-16T10:00:00Z");

function render(data: HomeLoaderData, url = "/app") {
  const Stub = createRoutesStub([{ id: "home", path: "/app", Component: Home, loader: () => data }]);
  return renderToString(<Stub initialEntries={[url]} hydrationData={{ loaderData: { home: data } }} />);
}

const home = (raw: HomeRaw, plan: PlanCode = "growth") => render(buildHome(raw, plan, NOW));

/** Occurrences of a substring. */
const count = (html: string, s: string) => html.split(s).length - 1;

describe("Home", () => {
  it("syncing: no Shop row yet shows one progress bar per dataset and no numbers", () => {
    const html = home({ shop: null, money: null, trackedVariants: 0, variantsWithCost: 0, salesDays: 0 });
    expect(html).toContain("Reading your store…");
    for (const label of ["Products", "Stock history", "Sales history", "Store visits"]) expect(html).toContain(label);
    // Nothing read yet: each dataset says "Waiting to start" instead of an empty bar.
    expect(count(html, "<s-progress")).toBe(0);
    expect(count(html, "Waiting to start")).toBe(4);
    expect(html).not.toContain("Money at stake");
    // Header: a quiet subtitle, never a lone dash.
    expect(html).toContain('heading="Dashboard"');
    expect(html).toContain("First sync in progress");
    expect(html).not.toContain("—</span></div>");
    // The order block waits for the sync.
    expect(html).toContain("Order this week");
    expect(html).toContain("Your order plan appears here once your products, stock and sales are read.");
    expect(html).toContain("Setup guide");
  });

  it("ready: four cards from the latest row, a null card shows a dash, popovers end with 'Based on:'", () => {
    const html = home(homeRaw(), "free");
    expect(html).toContain("Money at stake");
    expect(html).toContain("Sales at risk (next 28 days)");
    expect(html).toContain("Sales lost to sell-outs (last 90 days)");
    expect(html).toContain("Cash stuck");
    expect(html).toContain("Sold-out page visits (last 30 days)");
    expect(html).toContain("€1,235");
    expect(html).toContain("€800");
    expect(html).toContain("€0"); // a real zero stays a zero
    expect(html).toContain('<span class="keha-money__value">—</span>'); // lost90 is null
    expect(html).toContain("Not enough sales yet to advise");
    expect(count(html, "<s-popover")).toBe(4);
    expect(count(html, "Based on: ")).toBe(4);
    expect(html).toContain("Assumes stock on order arrives within 28 days");
    expect(html).toContain("Valued at retail price");
    // Free plan: money refreshes weekly now (audit 2026-10-17); the monthly note (and its upgrade
    // link) is gone until Home shows the weekly one (forecastNotes().refreshedWeekly).
    expect(html).not.toContain("Refreshed monthly on Free");
    // Older months still loading: bars stay, with the partial note.
    expect(html).toContain("Older months are still loading.");
    expect(count(html, "<s-progress")).toBe(4);
    // Header: store name + update time in the store's time zone (Madrid = UTC+2).
    expect(html).toContain('heading="Dashboard"');
    expect(html).toContain("Updated Oct 16, 06:10");
    expect(html).not.toContain("Data is late");
  });

  it("paid plans don't show the monthly note", () => {
    expect(home(homeRaw(), "growth")).not.toContain("Refreshed monthly on Free");
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
    expect(html).toContain("We need at least 14 days of sales to give advice.");
    expect(html).not.toContain("Sales at risk (next 28 days)");
  });

  it("no stock tracked: catalog read but nothing tracked", () => {
    const raw = homeRaw();
    raw.trackedVariants = 0;
    raw.variantsWithCost = 0;
    const html = home(raw);
    expect(html).toContain("Turn on &#x27;Track quantity&#x27; for your products in Shopify.");
    expect(html).toContain('href="shopify://admin/products"');
    expect(html).not.toContain("Sales at risk (next 28 days)");
  });

  it("data late: banner when the last nightly run is older than 36 h", () => {
    const raw = homeRaw();
    raw.shop!.lastNightlyAt = new Date("2026-10-14T03:00:00Z");
    const html = home(raw);
    expect(html).toContain("Data is late — no action needed, we&#x27;re retrying.");
  });

  it("setup guide: steps ticked from real state, hidden when all three are done", () => {
    const html = home(homeRaw());
    expect(html).toContain("How long do your suppliers take?");
    expect(html).toContain("Product costs found for 50% of products");
    expect(html).toContain("Every Monday at 08:00 to the store owner");
    expect(html).toContain('href="/app/settings"');
    expect(html).toContain('target="_top"');

    const raw = homeRaw();
    raw.shop!.settings = { leadTimeConfirmedAt: "2026-10-01T00:00:00Z", mondayEmail: { enabled: true, recipients: ["ops@acme.test"] } };
    raw.variantsWithCost = 190;
    const done = home(raw);
    expect(done).not.toContain("Setup guide");

    raw.variantsWithCost = 100;
    const partial = home(raw);
    expect(partial).toContain("Every Monday at 08:00 to ops@acme.test");
    expect(partial).toContain("Done");
  });
});

describe("Home: this week's actions (task 2.3)", () => {
  const withActions = (plan: PlanCode, actions: ActionListView | null, url?: string) =>
    render({ ...buildHome(homeRaw(), plan, NOW), actions }, url);

  it("Growth, All tab: every kind's row and button, € figures, the … menu, ranked by €", () => {
    const html = withActions("growth", actionList("growth"));
    expect(html).toContain("This week&#x27;s actions");
    for (const tab of ["All (8)", "Reorder (1)", "Bridge (1)", "Push (1)", "Fix (4)", "Clear (1)"]) expect(html).toContain(tab);
    expect(html).toContain("€8,200");
    expect(html).toContain("€3,400");
    // Ranked by € across groups: Clear (8,200) first, Reorder (3,400) next.
    expect(html.indexOf("Clear Cardigan")).toBeLessThan(html.indexOf("Reorder Tee"));
    expect(html.indexOf("Reorder Tee")).toBeLessThan(html.indexOf("Returns Romper"));
    // The reason: raw key fallback filled with its params.
    expect(html).toContain("Runs out in 1 days");
    expect(html).toContain("S, M");
    // Buttons per kind (spec §7.7).
    expect(html).toContain("Add to reorder plan");
    expect(html).toContain(`href="/app/reorder?variants=${encodeURIComponent("gid://shopify/ProductVariant/11,gid://shopify/ProductVariant/12")}"`);
    expect(html).toContain(">Collect back-in-stock sign-ups</s-button>");
    expect(html).toContain("Show how");
    expect(html).toContain("See why");
    expect(html).toContain('href="/app/products/41"');
    expect(html).toContain("Restock sizes");
    expect(html).toContain("Check the page");
    expect(html).toContain('href="shopify://admin/products/6"');
    expect(html).toContain("Check sizing / quality");
    expect(html).toContain("Create discount");
    // The … menu.
    expect(count(html, "<s-menu")).toBe(8);
    expect(html).toContain("Snooze 7 days");
    expect(html).toContain("Dismiss");
    expect(html).toContain(">Why<");
    // Keha Preorder isn't installed: never named or linked (Shopify 2.2.6).
    expect(html).not.toContain("keha-preorder");
    expect(html).not.toContain("Take preorders");
    // Nothing locked on Growth.
    expect(html).not.toContain("Product details to fix:");
    expect(html).not.toContain("More actions on the Growth plan");
  });

  it("Growth with Keha Preorder installed: the bridge opens its pre-filled form top-level", () => {
    const html = withActions("growth", actionList("growth", { preorderInstalled: true }));
    expect(html).toContain("Take preorders for the gap");
    expect(html).toContain(
      'href="https://admin.shopify.com/store/acme/apps/keha-preorder/app/campaigns/new?variants=21%2C22&amp;trigger=stock&amp;ship=2026-11-02&amp;name=Bridge+Boots" target="_top"',
    );
    expect(html).not.toContain(">Collect back-in-stock sign-ups</s-button>");
  });

  it("?tab=clear opens the Clear tab with the clearances running and the cash freed", () => {
    const html = withActions("growth", actionList("growth"), "/app?tab=clear");
    expect(html).toContain("Clear Cardigan");
    expect(html).not.toContain("Reorder Tee");
    expect(html).toContain('aria-selected="true" class="keha-tab keha-tab--active">Clear (1)');
    expect(html).toContain("Clearances running");
    expect(html).toContain("Old Overcoat");
    expect(html).toContain("Discount code CLEAR-7Q3K");
    expect(html).toContain("Ends Nov 15, 2026");
    expect(html).toContain("Cash freed so far: €1,200");
    expect(html).toContain("Valued at retail price");
  });

  it("?tab=fix shows only Fix rows; an unknown tab falls back to All", () => {
    const fix = withActions("growth", actionList("growth"), "/app?tab=fix");
    expect(fix).toContain("Falling Fleece");
    expect(fix).not.toContain("Clear Cardigan");
    expect(fix).not.toContain("Clearances running");
    const junk = withActions("growth", actionList("growth"), "/app?tab=nope");
    expect(junk).toContain("Clear Cardigan");
    expect(junk).toContain("Reorder Tee");
  });

  it("Free: top 10, Fix as a count, locked Bridge and Clear with an Upgrade link", () => {
    const html = withActions("free", actionList("free", { fillers: 12 }));
    expect(html).toContain("All (10)");
    expect(html).toContain("Fix (4)");
    expect(count(html, 'role="listitem"')).toBe(10);
    // Fix rows are counted, not shown (and not sent: they aren't in the list).
    expect(html).toContain("Product details to fix: 4");
    expect(html).toContain("Upgrade to see them");
    for (const title of ["Falling Fleece", "Sizes Sneaker", "Page Poncho", "Returns Romper"]) expect(html).not.toContain(title);
    // Bridge and Clear stay, locked: disabled button, plan badge, upgrade link.
    expect(html).toContain("Bridge Boots");
    expect(html).toContain("Clear Cardigan");
    expect(html).toContain('<s-button disabled="true">Bridge the gap</s-button>');
    expect(html).toContain('<s-button disabled="true">Create discount</s-button>');
    expect(html).toContain("Growth plan");
    expect(html).not.toContain(">Collect back-in-stock sign-ups</s-button>");
    // The rows past the top 10 are counted.
    expect(html).toContain("More actions on the Growth plan: 6");
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

describe("Dashboard: Order this week (Kanwar 2026-10-17)", () => {
  const ready = (plan: PlanCode = "growth") => buildHome(homeRaw(), plan, NOW);

  it("leads the page: per supplier the products, units, cash, order-by date and Review order; the 12-week strip", () => {
    const html = render({ ...ready(), orderPlan: { kind: "full", plan: orderPlanFixture() } });
    expect(html.indexOf("Order this week")).toBeLessThan(html.indexOf("Money at stake"));
    expect(html).toContain("Lisbon Linen");
    expect(html).toContain("Overdue");
    expect(html).toContain("Review order");
    // Review order → Order now with that supplier's orders of the next 7 days (a key, never a list of variants).
    expect(html).toContain('href="/app/reorder?supplier=supplier:s1&amp;from=2026-10-16&amp;to=2026-10-17"');
    expect(html).toMatch(/[\d,]+ units from 1 supplier · €[\d,]+/);
    expect(html).toMatch(/Cash needed, next 12 weeks: €[\d,]+/);
    expect(html).toContain("keha-orderplan-strip");
    expect(html).toContain('href="/app/reorder/calendar"');
    expect(html).toContain("12 products can&#x27;t be planned yet — not enough sales history.");
  });

  it("nothing due this week: names the next order; nothing at all: says so", () => {
    const fx = orderPlanFixture();
    const later = { ...fx, events: fx.events.filter((e) => e.orderBy > "2026-10-22") };
    const next = render({ ...ready(), orderPlan: { kind: "full", plan: later } });
    expect(next).toMatch(/Nothing to order this week\. Next order: (Lisbon Linen|Cap Co|Acme) by [A-Z][a-z]{2} \d+, 2026\./);
    const none = render({ ...ready(), orderPlan: { kind: "full", plan: { ...fx, events: [] } } });
    expect(none).toContain("No orders needed in the next 90 days.");
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
    expect(html).toContain("Group by supplier, send purchase orders, see the next 90 days");
    expect(html).not.toContain("Review order");
    expect(html).not.toContain("keha-orderplan-strip");
    expect(html).not.toContain("Lisbon Linen");
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
    expect(free.orderPlan).toMatchObject({ kind: "preview" });
    expect((free.orderPlan as { rows: unknown[] }).rows.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(free)).not.toContain("Lisbon Linen");
  });
});
