/**
 * SSR: the Dashboard's first-sync screen (owner 2026-10-17, components/sync-progress) — small,
 * medium and large stores, the ETA, what to do meanwhile (plan locks teach), the email promise
 * only when the email can go out, errors naming the month, the compact card once numbers show,
 * the ready notice, and the screen in another language.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/services/entitlements.server", () => ({ planFor: vi.fn(), getEntitlements: vi.fn() }));
vi.mock("../app/models/dashboard.server", () => ({ getHomeData: vi.fn(), reviewAskDue: vi.fn(async () => null) }));
vi.mock("../app/models/settings.server", () => ({ recordReviewAsk: vi.fn(async () => true) }));
vi.mock("../app/models/actions.server", () => ({ getActionList: vi.fn() }));
vi.mock("../app/services/keha-preorder.server", () => ({ kehaPreorderInstalled: vi.fn() }));
vi.mock("../app/models/order-plan.server", () => ({ loadOrderPlan: vi.fn() }));

import Home, { type HomeLoaderData } from "../app/routes/app._index";
import { SyncProgress } from "../app/components/sync-progress";
import { buildHome, type HomeRaw } from "../app/lib/dashboard-shared";
import { buildSyncView } from "../app/lib/sync-progress-shared";
import { LocaleProvider } from "../app/lib/i18n";
import type { PlanCode } from "../app/lib/plan-shared";
import type { BackfillState } from "../app/lib/sync/backfill-shared";
import { homeRaw } from "./home-fixtures";
import { orderPlanFixture } from "./order-plan-fixtures";
import { previewRows } from "../app/lib/order-plan-shared";

const NOW = new Date("2026-10-16T10:00:00Z");
const RANGE = { from: "2025-09-01", until: "2026-10-15" };

function render(data: HomeLoaderData) {
  const Stub = createRoutesStub([{ id: "home", path: "/app", Component: Home, loader: () => data }]);
  return renderToString(<Stub initialEntries={["/app"]} hydrationData={{ loaderData: { home: data } }} />);
}

/** A store in its first read: catalog in, `months` of each history dataset read, started 2 h ago. */
function syncing(variants: number, months: number, extra: { planReadyEmail?: boolean; backfill?: Partial<BackfillState>; settings?: unknown } = {}): HomeRaw {
  const ds = (n: number) => ({ done: n, total: 14 });
  return {
    shop: {
      domain: "acme.myshopify.com",
      currency: "EUR",
      timezone: "Europe/Madrid",
      settings: extra.settings ?? {},
      backfillState: {
        startedAt: "2026-10-16T07:55:00Z",
        range: RANGE,
        datasets: {
          products: { done: 1, total: 1, finishedAt: "2026-10-16T08:00:00Z" },
          stock: ds(months),
          sales: ds(months),
          visits: ds(months),
          totals: ds(months),
        },
        ...extra.backfill,
      },
      lastNightlyAt: null,
    },
    money: null,
    trackedVariants: variants,
    variantsWithCost: 0,
    salesDays: 0,
    supplierCount: 0,
    planReadyEmail: extra.planReadyEmail ?? true,
  };
}

const home = (raw: HomeRaw, plan: PlanCode = "growth") => render(buildHome(raw, plan, NOW));

describe("first sync: the sync screen", () => {
  it("small store: stages with months read, a measured ETA, the email promise and what to do meanwhile", () => {
    const html = home(syncing(400, 2));
    expect(html).toContain("Setting up your order plan");
    expect(html).toContain("We&#x27;re reading up to 14 months of sales, so the plan can reflect your seasons.");
    expect(html).toContain("You can close this page — we keep reading in the background.");
    expect(html).toContain("We&#x27;ll email you when your order plan is ready.");
    // 2 months of 4 datasets = 8 months in 2 h: 15 min a month, 48 left = 12 h.
    expect(html).toContain("About 12 hours left");
    expect(html).toContain("Worked out from how fast your store has been read so far.");
    expect(html.split("2 of 14 months").length - 1).toBe(3); // stock, sales, visits
    expect(html).toContain('data-stage="plan" data-status="waiting"');
    // While you wait: points at the setup guide below (lead time, suppliers) and offers the CSV import (Growth).
    expect(html).toContain("While you wait");
    expect(html).toContain("Set your lead times and suppliers in the setup guide below");
    expect(html).toContain('href="/app/settings/import"');
    expect(html).toContain(">Import from a CSV</s-button>");
    expect(html.indexOf("While you wait")).toBeLessThan(html.indexOf("Setup guide"));
    // No numbers yet, never "nothing to order".
    expect(html).not.toContain("Money at stake");
    expect(html).not.toContain("Nothing to order");
  });

  it("medium and large stores: the large-store sentence only from 20,000 variants; an estimate before anything is measured", () => {
    expect(home(syncing(5_000, 2))).toContain("You can close this page — we keep reading in the background.");
    const large = home(syncing(45_000, 0));
    expect(large).toContain("Large stores take a few hours — you can close this page.");
    expect(large).toContain("A first estimate from your store&#x27;s size (45,000 variants). It gets more precise once the first months are in.");
    expect(large).toMatch(/About \d+ hours left/);
  });

  it("no email promise when the email can't go out (sending not set up, already sent, or Monday email off)", () => {
    const noTransport = home(syncing(400, 2, { planReadyEmail: false }));
    expect(noTransport).not.toContain("We&#x27;ll email you");
    expect(noTransport).toContain("Your order plan appears here when it&#x27;s ready.");
    const mondayOff = home(syncing(400, 2, { settings: { mondayEmail: { enabled: false } } }));
    expect(mondayOff).not.toContain("We&#x27;ll email you");
  });

  it("errors: the month that failed, retried automatically; skipped months named", () => {
    const raw = syncing(400, 3);
    const st = raw.shop!.backfillState as BackfillState;
    st.datasets!.sales = { done: 3, total: 14, lastError: "boom", lastErrorCode: "unknown", attempts: 1 };
    st.datasets!.visits = { done: 4, total: 14, skippedMonths: ["2026-07-01"], degraded: true };
    const html = home(raw);
    expect(html).toContain("We couldn&#x27;t read sales for July 2026 — we&#x27;ll retry automatically.");
    expect(html).toContain('data-stage="sales" data-status="retrying"');
    expect(html).toContain("We couldn&#x27;t read store visits for July 2026 after several tries. Your plan uses the other months.");
  });

  it("Free: the CSV import teaches its plan instead of hiding", () => {
    const html = home(syncing(400, 2), "free");
    expect(html).toContain("Import from a CSV · Growth plan");
    expect(html).toContain('href="/app/settings/import"');
  });

  it("lead time and suppliers set: 'While you wait' offers the CSV import on its own", () => {
    const raw = syncing(400, 2, { settings: { leadTimeConfirmedAt: "2026-10-16T09:00:00Z" } });
    raw.supplierCount = 2;
    const html = home(raw);
    expect(html).toContain("Many products? Set case packs, suppliers and Don&#x27;t reorder for all of them at once from a CSV.");
    expect(html).toContain(">Import from a CSV</s-button>");
  });

  it("in the admin's language", () => {
    const view = buildSyncView({ state: syncing(400, 2).shop!.backfillState as BackfillState, now: NOW, trackedVariants: 400, catalogDone: true, planBuiltAt: null, emailOnReady: true });
    const html = renderToString(
      <LocaleProvider defaultLocale="de">
        <SyncProgress view={view} mode="full" />
      </LocaleProvider>,
    );
    expect(html).toContain("Dein Bestellplan wird eingerichtet");
    expect(html).toContain("2 von 14 Monaten");
    expect(html).toContain("Noch etwa 12 Stunden");
  });
});

describe("after the first months: compact card and labels", () => {
  it("numbers show with 'Based on …' and the compact card sits below them", () => {
    const raw = homeRaw();
    (raw.shop!.backfillState as BackfillState).datasets!.stock = { done: 3, total: 13 };
    (raw.shop!.backfillState as BackfillState).datasets!.sales = { done: 3, total: 13 };
    const html = render({ ...buildHome(raw, "growth", NOW), orderPlan: { kind: "full", plan: orderPlanFixture() } });
    expect(html.split("Based on the last 90 days so far").length - 1).toBe(3); // the order block, the money line, the card
    expect(html).toContain("Still reading older months");
    expect(html).not.toContain("Setting up your order plan");
    expect(html.indexOf("Order this week")).toBeLessThan(html.indexOf("Still reading older months"));
    // Free's preview says it too.
    const free = render({ ...buildHome(raw, "free", NOW), orderPlan: { kind: "preview", rows: previewRows(orderPlanFixture()) } });
    expect(free.split("Based on the last 90 days so far").length - 1).toBe(3);
  });

  it("the read finished: 'Your order plan is ready' for a few days, no sync card", () => {
    const raw = homeRaw();
    const st = raw.shop!.backfillState as BackfillState;
    st.finishedAt = "2026-10-15T20:00:00Z";
    for (const d of ["stock", "sales", "visits", "totals"] as const) st.datasets![d] = { done: 13, total: 13 };
    st.range = { from: "2025-09-01", until: "2026-10-15" };
    raw.firstSaleDay = "2024-05-01"; // 14+ months of sales: capped at the read window
    const html = home(raw);
    expect(html).toContain('heading="Your order plan is ready"');
    expect(html).toContain("We read 14 months of your sales, so your plan reflects your seasons.");
    expect(html).not.toContain("Still reading older months");
    expect(html).not.toContain("so far");
    st.finishedAt = "2026-10-01T20:00:00Z";
    expect(home(raw)).not.toContain("Your order plan is ready");
  });

  it("the ready notice says the months of sales really read, not the read window (listing audit 2026-10-18)", () => {
    const raw = homeRaw();
    const st = raw.shop!.backfillState as BackfillState;
    st.finishedAt = "2026-10-15T20:00:00Z";
    st.range = { from: "2025-09-01", until: "2026-10-15" };
    for (const d of ["stock", "sales", "visits", "totals"] as const) st.datasets![d] = { done: 14, total: 14 };
    const notice = (first: string | null) => {
      raw.firstSaleDay = first;
      const html = home(raw);
      expect(html).toContain('heading="Your order plan is ready"');
      return html;
    };
    // 3 months of sales: no seasons claim, no "14".
    const three = notice("2026-07-01");
    expect(three).toContain("We read your 3 months of sales.");
    expect(three).not.toContain("reflects your seasons");
    expect(three).not.toContain("14 months");
    // 13 months: seasons.
    expect(notice("2025-09-15")).toContain("We read 13 months of your sales, so your plan reflects your seasons.");
    // 14+ months: capped at 14.
    expect(notice("2023-01-01")).toContain("We read 14 months of your sales, so your plan reflects your seasons.");
    // No sales found: an honest line, never a month count.
    const none = notice(null);
    expect(none).toContain("We didn&#x27;t find any sales yet. Your plan fills in as sales come in.");
    expect(none).not.toMatch(/months of (your )?sales/);
  });
});
