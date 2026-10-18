/**
 * Instant alert rules (spec §11, task 2.6), at their edges: best seller (A role)
 * with daysLeft < lead time; a sell-out that STARTED on a product with ≥ 50
 * sessions a week; one alert per product (sell-out first); the cap per message;
 * wording in the store's language; email and Slack rendering.
 */
import { describe, expect, it } from "vitest";
import {
  BUSY_SESSIONS_PER_WEEK,
  MAX_ALERTS_PER_MESSAGE,
  alertLine,
  alertMessage,
  composeAlertEmail,
  fullyOut,
  knownNotFullyOut,
  lowBestSellers,
  pickAlerts,
  sellOutsStarted,
  variantLabel,
  type InstantAlert,
  type MetricLite,
} from "../app/lib/alerts-shared";
import { buildSlackAlerts } from "../app/lib/slack-shared";

const m = (over: Partial<MetricLite>): MetricLite => ({ variantId: "v1", productId: "p1", role: "A", daysLeft: 5, leadTimeDays: 14, ...over });

describe("rule (a): best seller runs out within its lead time", () => {
  it("fires below the lead time, not at or above it", () => {
    expect(lowBestSellers([m({ daysLeft: 13.9 })]).get("p1")).toEqual({ variantId: "v1", daysLeft: 13.9, leadTimeDays: 14 });
    expect(lowBestSellers([m({ daysLeft: 14 })]).size).toBe(0);
    expect(lowBestSellers([m({ daysLeft: 20 })]).size).toBe(0);
  });
  it("only the A role; unknown or never-runs-out days never fire", () => {
    expect(lowBestSellers([m({ role: "B", daysLeft: 1 }), m({ role: "C", daysLeft: 1, variantId: "v2" })]).size).toBe(0);
    expect(lowBestSellers([m({ daysLeft: null })]).size).toBe(0);
    expect(lowBestSellers([m({ daysLeft: Infinity })]).size).toBe(0);
  });
  it("a sold-out best seller (daysLeft 0) counts; a lead time of 0 never fires", () => {
    expect(lowBestSellers([m({ daysLeft: 0 })]).size).toBe(1);
    expect(lowBestSellers([m({ daysLeft: 0, leadTimeDays: 0 })]).size).toBe(0);
  });
  it("one entry per product: the variant that runs out first, each with its own lead time", () => {
    const r = lowBestSellers([
      m({ variantId: "v2", daysLeft: 9 }),
      m({ variantId: "v1", daysLeft: 3 }),
      m({ variantId: "v3", daysLeft: 3 }),
      m({ productId: "p2", variantId: "v9", daysLeft: 25, leadTimeDays: 30 }),
    ]);
    expect(r.get("p1")?.variantId).toBe("v1");
    expect(r.get("p2")).toEqual({ variantId: "v9", daysLeft: 25, leadTimeDays: 30 });
  });
});

describe("rule (b): a sell-out started on a busy product", () => {
  const out = (o: Record<string, boolean>) => new Map(Object.entries(o));
  const product = { productId: "p1", handle: "Linen-Shirt", variantIds: ["v1", "v2"] };
  const busy = new Map([["linen-shirt", BUSY_SESSIONS_PER_WEEK]]);

  it("fully out now, partly in stock on the last stock day, ≥ 50 sessions: fires", () => {
    expect(sellOutsStarted([product], out({ v1: true, v2: true }), out({ v1: true, v2: false }), busy)).toEqual(new Map([["p1", 50]]));
  });
  it("49 sessions: no alert", () => {
    expect(sellOutsStarted([product], out({ v1: true, v2: true }), out({ v1: false, v2: false }), new Map([["linen-shirt", 49]])).size).toBe(0);
  });
  it("already fully out on the last stock day: not a new sell-out", () => {
    expect(sellOutsStarted([product], out({ v1: true, v2: true }), out({ v1: true, v2: true }), busy).size).toBe(0);
  });
  it("one size still in stock now: not sold out", () => {
    expect(sellOutsStarted([product], out({ v1: true, v2: false }), out({ v1: false, v2: false }), busy).size).toBe(0);
  });
  it("unknown stock is neither in nor out", () => {
    expect(sellOutsStarted([product], out({ v1: true }), out({ v1: false, v2: false }), busy).size).toBe(0);
    expect(sellOutsStarted([product], out({ v1: true, v2: true }), out({ v1: false }), busy).size).toBe(0);
    expect(fullyOut([], new Map())).toBe(false);
    expect(knownNotFullyOut(["v1"], new Map())).toBe(false);
  });
});

describe("pickAlerts", () => {
  const products = new Map([
    ["p1", { title: "Linen Shirt", variantIds: ["v1", "v2"], variantTitles: new Map([["v2", "Blue / M"]]) }],
    ["p2", { title: "Tote", variantIds: ["v3"] }],
    ["p3", { title: "Cap", variantIds: ["v4"] }],
  ]);

  it("one alert per product, the sell-out first; skips products alerted in the last 7 days", () => {
    const low = new Map([
      ["p1", { variantId: "v2", daysLeft: 0, leadTimeDays: 14 }],
      ["p2", { variantId: "v3", daysLeft: 4, leadTimeDays: 14 }],
      ["p3", { variantId: "v4", daysLeft: 2, leadTimeDays: 14 }],
    ]);
    const sell = new Map([["p1", 120]]);
    const r = pickAlerts(products, low, sell, new Set(["p3"]));
    expect(r).toEqual([
      { kind: "sell_out", productId: "p1", variantId: "v1", title: "Linen Shirt", sessions: 120 },
      { kind: "low_best_seller", productId: "p2", variantId: "v3", title: "Tote", daysLeft: 4, leadTimeDays: 14 },
    ]);
    expect(pickAlerts(products, low, new Map(), new Set())[0]).toMatchObject({ productId: "p1", title: "Linen Shirt (Blue / M)" });
  });

  it("at most MAX_ALERTS_PER_MESSAGE, most urgent first", () => {
    const many = new Map(Array.from({ length: 15 }, (_, i) => [`p${i}`, { title: `P${i}`, variantIds: [`v${i}`] }]));
    const low = new Map(Array.from({ length: 15 }, (_, i) => [`p${i}`, { variantId: `v${i}`, daysLeft: 15 - i, leadTimeDays: 30 }]));
    const r = pickAlerts(many, low, new Map(), new Set());
    expect(r).toHaveLength(MAX_ALERTS_PER_MESSAGE);
    expect(r[0]).toMatchObject({ productId: "p14", daysLeft: 1 });
  });

  it("ignores products that are not in the catalog", () => {
    expect(pickAlerts(products, new Map([["gone", { variantId: "x", daysLeft: 1, leadTimeDays: 9 }]]), new Map(), new Set())).toEqual([]);
  });

  it("variant labels drop Shopify's Default Title", () => {
    expect(variantLabel("Default Title")).toBeNull();
    expect(variantLabel(" Red ")).toBe("Red");
    expect(variantLabel(null)).toBeNull();
  });
});

describe("wording", () => {
  const low: InstantAlert = { kind: "low_best_seller", productId: "p", variantId: "v", title: "Tote", daysLeft: 3.46, leadTimeDays: 14 };
  const out: InstantAlert = { ...low, daysLeft: 0 };
  const sell: InstantAlert = { kind: "sell_out", productId: "p", variantId: "v", title: "Cap", sessions: 64 };

  it("English and translated lines", () => {
    expect(alertLine("en", low, "https://l")).toEqual({
      title: "Best seller running out: Tote",
      detail: "Days of stock: 3.5. New stock takes 14 days.",
      link: "https://l",
    });
    expect(alertLine("en", out, "https://l").title).toBe("Best seller sold out: Tote");
    expect(alertLine("en", out, "https://l").detail).toBe("New stock takes 14 days.");
    expect(alertLine("en", sell, "https://l")).toMatchObject({ title: "Just sold out: Cap", detail: "Visits to this product last week: 64." });
    expect(alertLine("es", low, "https://l", "es-ES").detail).toBe("Días de stock: 3,5. El stock nuevo tarda 14 días.");
    expect(alertLine("de", sell, "https://l").title).toBe("Gerade ausverkauft: Cap");
  });

  it("without the forecast (Free) the days-left figure is left out, the alert stays", () => {
    expect(alertLine("en", low, "https://l", "en", false)).toEqual({ title: "Best seller running out: Tote", detail: "New stock takes 14 days.", link: "https://l" });
    expect(alertLine("en", out, "https://l", "en", false).title).toBe("Best seller sold out: Tote");
  });

  it("subject: the alert itself, or a count; footer links to the Alerts settings", () => {
    const one = alertMessage("en", "Acme", [alertLine("en", sell, "https://l")], "https://settings");
    expect(one.subject).toBe("Just sold out: Cap");
    const two = alertMessage("fr", "Acme", [alertLine("fr", sell, "https://a"), alertLine("fr", low, "https://b")], "https://settings");
    expect(two.subject).toBe("2 alertes de stock urgentes");
    expect(two.heading).toBe("Alertes de stock urgentes pour Acme");
  });

  it("email: text and escaped HTML with a button per product", () => {
    const msg = alertMessage("en", `A&B <shop>`, [alertLine("en", { ...sell, title: "<b>Cap</b>" }, "https://x/1")], "https://settings");
    const e = composeAlertEmail("en", msg);
    expect(e.text).toContain("Just sold out: <b>Cap</b>");
    expect(e.text).toContain("Open in Keha: https://x/1");
    expect(e.text).toContain("Change alert settings: https://settings");
    expect(e.html).toContain("&lt;b&gt;Cap&lt;/b&gt;");
    expect(e.html).not.toContain("<b>Cap</b>");
    expect(e.html).toContain('href="https://x/1"');
    expect(e.html).toContain("A&amp;B &lt;shop&gt;");
  });

  it("Slack: heading and linked lines, escaped", () => {
    const msg = alertMessage("en", "Acme", [alertLine("en", { ...sell, title: "Cap & Co" }, "https://x/1")], "https://settings");
    expect(buildSlackAlerts(msg).text).toBe(
      "*Urgent stock alerts for Acme*\n• <https://x/1|Just sold out: Cap &amp; Co>\n    Visits to this product last week: 64.\n\n<https://settings|Change alert settings>",
    );
  });
});
