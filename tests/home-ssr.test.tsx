/**
 * SSR: Home (task 1.6) in its four states — syncing (no Shop row yet),
 * ready (4 money cards, one null card shows "—"), not enough sales, no stock
 * tracked — plus the data-late banner, the Free refresh note and the setup guide.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/services/entitlements.server", () => ({ planFor: vi.fn(), getEntitlements: vi.fn() }));
vi.mock("../app/models/dashboard.server", () => ({ getHomeData: vi.fn() }));

import Home from "../app/routes/app._index";
import { buildHome, type HomeData, type HomeRaw } from "../app/lib/dashboard-shared";
import type { PlanCode } from "../app/lib/plan-shared";
import { homeRaw } from "./home-fixtures";

const NOW = new Date("2026-10-16T10:00:00Z");

function render(data: HomeData) {
  const Stub = createRoutesStub([{ id: "home", path: "/app", Component: Home, loader: () => data }]);
  return renderToString(<Stub initialEntries={["/app"]} hydrationData={{ loaderData: { home: data } }} />);
}

const home = (raw: HomeRaw, plan: PlanCode = "growth") => render(buildHome(raw, plan, NOW));

/** Occurrences of a substring. */
const count = (html: string, s: string) => html.split(s).length - 1;

describe("Home", () => {
  it("syncing: no Shop row yet shows one progress bar per dataset and no numbers", () => {
    const html = home({ shop: null, money: null, trackedVariants: 0, variantsWithCost: 0, salesDays: 0 });
    expect(html).toContain("Reading your store…");
    for (const label of ["Products", "Stock history", "Sales history", "Store visits"]) expect(html).toContain(label);
    expect(count(html, "<s-progress")).toBe(4);
    expect(html).not.toContain("Money at stake");
    expect(html).toContain("Data updated —");
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
    // Free plan: monthly refresh with an upgrade link.
    expect(html).toContain("Refreshed monthly on Free");
    expect(html).toContain('href="/app/plans"');
    // Older months still loading: bars stay, with the partial note.
    expect(html).toContain("Older months are still loading.");
    expect(count(html, "<s-progress")).toBe(4);
    // Header: store name + update time in the store's time zone (Madrid = UTC+2).
    expect(html).toContain("acme");
    expect(html).toContain("06:10");
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
