/**
 * The hourly instant-alerts job (spec §11, task 2.6) on seeded tables: email on
 * every plan in the store's language, Slack only on Growth when connected, the
 * 7-day cap per product and channel (AlertLog written only after a send), the
 * "Send instant alerts" switch, stale metrics, and a sell-out that started.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb, Row } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ alertLog: ["shop", "productId", "kind", "channel", "sentAt"] });
  return { default: db.client, __fake: db };
});
const { planFor, sendOwnerEmailOnce, deliverSlack, ownerContact } = vi.hoisted(() => ({
  planFor: vi.fn(async (_s: string) => "growth"),
  sendOwnerEmailOnce: vi.fn(async (..._a: unknown[]) => "sent" as "sent" | "failed" | "skipped"),
  deliverSlack: vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: true } | { ok: false; code: string; permanent: boolean } | "skipped"),
  ownerContact: vi.fn(async () => ({ name: "Acme Shoes", to: "owner@acme.test", locale: "en" })),
}));
vi.mock("../app/services/entitlements.server", () => ({ planFor: (s: string) => planFor(s) }));
vi.mock("../app/services/owner-email.server", () => ({
  ownerContact: () => ownerContact(),
  sendOwnerEmailOnce: (...a: unknown[]) => sendOwnerEmailOnce(...a),
}));
vi.mock("../app/services/slack.server", () => ({ deliverSlack: (...a: unknown[]) => deliverSlack(...a) }));

import * as dbModule from "../app/db.server";
import { runAlertsAllShops, runAlertsForShop, type AlertsShopRow } from "../app/services/alerts.server";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const NOW = new Date("2026-10-16T10:00:00Z"); // 12:00 in Madrid, store day 2026-10-16
const HOUR = 60 * 60 * 1000;
const d = (day: string) => new Date(`${day}T00:00:00.000Z`);
const L1 = "gid://shopify/Location/1";
const P = (n: number) => `gid://shopify/Product/${n}`;
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;

function shopRow(settings: Row = {}): AlertsShopRow {
  return { domain: S, currency: "EUR", timezone: "Europe/Madrid", locale: "es", uninstalledAt: null, settings };
}

function variant(n: number, product: number, handle: string, title = `Product ${product}`, variantTitle = "Default Title"): Row {
  return { id: V(n), shop: S, productId: P(product), productTitle: title, variantTitle, handle, tracked: true, isBundle: false, status: "ACTIVE" };
}
function metric(n: number, over: Row = {}): Row {
  return {
    shop: S, variantId: V(n), scope: "online", status: "healthy", role: "B", daysLeft: 60, orderQty: null, orderBy: null,
    computedAt: new Date(NOW.getTime() - 5 * HOUR), inputs: { leadTimeDays: 14 }, ...over,
  };
}

/**
 * P1 "tote": a best seller with 5 days left (lead time 14) → rule (a).
 * P2 "cap": sold out now, in stock yesterday, 70 visits this week → rule (b).
 * P3 "scarf": healthy.
 */
function seed() {
  db.reset();
  db.tables.variant = [variant(1, 1, "tote", "Tote"), variant(2, 2, "cap", "Cap"), variant(3, 3, "scarf", "Scarf")];
  db.tables.variantMetric = [metric(1, { role: "A", status: "running_low", daysLeft: 5 }), metric(2, { status: "out", daysLeft: 0 }), metric(3)];
  db.tables.location = [{ id: L1, shop: S, active: true, online: true }];
  db.tables.stockNow = [
    { shop: S, variantId: V(1), locationId: L1, onHand: 10 },
    { shop: S, variantId: V(2), locationId: L1, onHand: 0 },
    { shop: S, variantId: V(3), locationId: L1, onHand: 80 },
  ];
  db.tables.stockDaily = [
    { shop: S, day: d("2026-10-15"), variantId: V(2), locationId: L1, endUnits: 3, outOfStock: false },
    { shop: S, day: d("2026-10-14"), variantId: V(2), locationId: L1, endUnits: 6, outOfStock: false },
  ];
  db.tables.sessionsDaily = [
    { shop: S, day: d("2026-10-15"), landingPath: "/products/cap", trafficType: "Organic", sessions: 40, checkouts: 1 },
    { shop: S, day: d("2026-10-12"), landingPath: "/es/products/cap", trafficType: "Paid", sessions: 30, checkouts: 0 },
    { shop: S, day: d("2026-10-01"), landingPath: "/products/cap", trafficType: "Paid", sessions: 500, checkouts: 0 }, // older than a week
    { shop: S, day: d("2026-10-15"), landingPath: "/", trafficType: "Organic", sessions: 900, checkouts: 9 },
  ];
  db.tables.alertLog = [];
}

type EmailCall = [string, { kind: string; periodKey: string; subject: string; text: string; html: string }, { to: string | string[]; locale: string }];

beforeEach(() => {
  seed();
  planFor.mockReset();
  planFor.mockResolvedValue("growth");
  sendOwnerEmailOnce.mockReset();
  sendOwnerEmailOnce.mockResolvedValue("sent");
  deliverSlack.mockReset();
  deliverSlack.mockResolvedValue({ ok: true });
});

describe("instant alerts", () => {
  it("emails both alerts in the store's language, with links into the app, and logs them", async () => {
    expect(await runAlertsForShop(shopRow(), NOW)).toEqual({ instant: "sent" });
    expect(sendOwnerEmailOnce).toHaveBeenCalledTimes(1);
    const [shop, email, contact] = sendOwnerEmailOnce.mock.calls[0] as EmailCall;
    expect(shop).toBe(S);
    expect(email.kind).toBe("alert");
    expect(email.periodKey).toBe("2026-10-16T10");
    expect(email.subject).toBe("2 alertas urgentes de stock");
    expect(email.text).toContain("Recién agotado: Cap");
    expect(email.text).toContain("Visitas a este producto la semana pasada: 70.");
    expect(email.text).toContain("Producto estrella a punto de agotarse: Tote");
    expect(email.text).toContain("Días de stock restantes: 5. El stock nuevo tarda 14 días.");
    expect(email.text).toContain("https://admin.shopify.com/store/acme/apps/keha-inventory/app/products/2");
    expect(email.text).toContain("https://admin.shopify.com/store/acme/apps/keha-inventory/app/settings/alerts");
    expect(email.text).not.toContain("Scarf");
    expect(contact).toMatchObject({ to: "owner@acme.test", locale: "es" });
    expect(db.tables.alertLog.map((r) => [r.productId, r.kind, r.channel])).toEqual([
      [P(2), "sell_out", "email"],
      [P(1), "low_best_seller", "email"],
    ]);
    expect(deliverSlack).not.toHaveBeenCalled(); // Slack not connected
  });

  it("at most once per product per 7 days", async () => {
    await runAlertsForShop(shopRow(), NOW);
    expect(await runAlertsForShop(shopRow(), new Date(NOW.getTime() + HOUR))).toEqual({ instant: "nothing" });
    expect(await runAlertsForShop(shopRow(), new Date(NOW.getTime() + 6 * 24 * HOUR))).toEqual({ instant: "nothing" });
    expect(sendOwnerEmailOnce).toHaveBeenCalledTimes(1);
    // 7 days later the best seller is still low (fresh metrics): alerted again.
    const later = new Date(NOW.getTime() + 7 * 24 * HOUR + HOUR);
    for (const m of db.tables.variantMetric) m.computedAt = new Date(later.getTime() - HOUR);
    expect(await runAlertsForShop(shopRow(), later)).toEqual({ instant: "sent" });
    const [, email] = sendOwnerEmailOnce.mock.calls[1] as EmailCall;
    expect(email.subject).toBe("Producto estrella a punto de agotarse: Tote");
  });

  it("goes to the Monday recipients when set", async () => {
    await runAlertsForShop(shopRow({ mondayEmail: { enabled: false, recipients: ["ops@acme.test"] } }), NOW);
    expect((sendOwnerEmailOnce.mock.calls[0] as EmailCall)[2].to).toEqual(["ops@acme.test"]);
  });

  it("a failed or skipped email is not logged, so the next hour tries again", async () => {
    sendOwnerEmailOnce.mockResolvedValueOnce("failed");
    expect(await runAlertsForShop(shopRow(), NOW)).toEqual({ instant: "failed" });
    expect(db.tables.alertLog).toEqual([]);
    sendOwnerEmailOnce.mockResolvedValueOnce("skipped");
    expect(await runAlertsForShop(shopRow(), NOW)).toEqual({ instant: "nothing" });
    expect(db.tables.alertLog).toEqual([]);
    expect(await runAlertsForShop(shopRow(), new Date(NOW.getTime() + HOUR))).toEqual({ instant: "sent" });
    expect(db.tables.alertLog).toHaveLength(2);
  });

  it("Slack on Growth when connected: same alerts, its own 7-day cap", async () => {
    const settings = { alerts: { instant: true, slackWebhook: "gcm:sealed" } };
    await runAlertsForShop(shopRow(settings), NOW);
    expect(deliverSlack).toHaveBeenCalledTimes(1);
    const [, , message] = deliverSlack.mock.calls[0] as [string, unknown, { text: string }];
    expect(message.text).toContain("*Alertas urgentes de stock para Acme Shoes*");
    expect(message.text).toContain("|Recién agotado: Cap>");
    expect(db.tables.alertLog.filter((r) => r.channel === "slack")).toHaveLength(2);

    // Slack failed last time for a product → only Slack retries it.
    db.tables.alertLog = db.tables.alertLog.filter((r) => !(r.channel === "slack" && r.productId === P(1)));
    await runAlertsForShop(shopRow(settings), new Date(NOW.getTime() + HOUR));
    expect(sendOwnerEmailOnce).toHaveBeenCalledTimes(1);
    expect(deliverSlack).toHaveBeenCalledTimes(2);
    expect((deliverSlack.mock.calls[1] as [string, unknown, { text: string }])[2].text).toContain("Tote");
  });

  it("Slack failures are not logged; Free gets email only", async () => {
    deliverSlack.mockResolvedValueOnce({ ok: false, code: "invalid_token", permanent: true });
    await runAlertsForShop(shopRow({ alerts: { slackWebhook: "gcm:sealed" } }), NOW);
    expect(db.tables.alertLog.every((r) => r.channel === "email")).toBe(true);

    seed();
    planFor.mockResolvedValue("free");
    deliverSlack.mockClear();
    expect(await runAlertsForShop(shopRow({ alerts: { slackWebhook: "gcm:sealed" } }), NOW)).toEqual({ instant: "sent" });
    expect(deliverSlack).not.toHaveBeenCalled();
    expect(sendOwnerEmailOnce).toHaveBeenCalled();
  });

  it("off in Settings: nothing is read or sent", async () => {
    expect(await runAlertsForShop(shopRow({ alerts: { instant: false } }), NOW)).toEqual({ instant: "off" });
    expect(sendOwnerEmailOnce).not.toHaveBeenCalled();
    expect(db.calls.filter((c) => c.table === "variantMetric")).toEqual([]);
  });

  it("stale metrics: no best-seller alert; the sell-out (live stock) still goes out", async () => {
    for (const m of db.tables.variantMetric) m.computedAt = new Date(NOW.getTime() - 37 * HOUR);
    await runAlertsForShop(shopRow(), NOW);
    const [, email] = sendOwnerEmailOnce.mock.calls[0] as EmailCall;
    expect(email.subject).toBe("Recién agotado: Cap");
  });

  it("no sell-out alert when it was already out yesterday, or the page is quiet", async () => {
    db.tables.stockDaily[0] = { ...db.tables.stockDaily[0], endUnits: 0, outOfStock: true };
    await runAlertsForShop(shopRow(), NOW);
    expect((sendOwnerEmailOnce.mock.calls[0] as EmailCall)[1].subject).toBe("Producto estrella a punto de agotarse: Tote");

    seed();
    sendOwnerEmailOnce.mockClear();
    db.tables.sessionsDaily = db.tables.sessionsDaily.filter((r) => r.landingPath !== "/es/products/cap"); // 40 this week
    await runAlertsForShop(shopRow(), NOW);
    expect((sendOwnerEmailOnce.mock.calls[0] as EmailCall)[1].text).not.toContain("Cap");
  });

  it("nothing to say: no email", async () => {
    db.tables.variantMetric = [metric(1), metric(2), metric(3)];
    db.tables.stockNow[1].onHand = 4;
    expect(await runAlertsForShop(shopRow(), NOW)).toEqual({ instant: "nothing" });
    expect(sendOwnerEmailOnce).not.toHaveBeenCalled();
  });

  it("every installed store; one failure doesn't stop the others", async () => {
    db.tables.shop = [
      { ...shopRow(), settings: {} },
      { ...shopRow(), domain: "broken.myshopify.com", settings: {} },
      { ...shopRow(), domain: "gone.myshopify.com", uninstalledAt: new Date() },
    ];
    planFor.mockImplementation(async (s: string) => (s === "broken.myshopify.com" ? Promise.reject(new Error("x")) : "growth"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const counts = await runAlertsAllShops(NOW);
    err.mockRestore();
    expect(counts["instant:sent"]).toBe(1);
    expect(counts["instant:nothing"]).toBe(1); // broken shop: plan fails open, no data of its own
    expect(counts.error).toBeUndefined();
  });
});
