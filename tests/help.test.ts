import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildOrderHelp, calendarHelp, dashboardHelp, dueNowHelp, plansHelp, productDetailHelp, productsHelp, purchaseOrdersHelp, seasonHelp, settingsHelp } from "../app/components/help";
import { translate } from "../app/lib/i18n";

// Kanwar 2026-10-18: a "How it works" panel on every page, in plain words, with the store's own numbers.
const tEn = (s: string) => translate("en", s);
const tDe = (s: string) => translate("de", s);
const text = (c: ReturnType<typeof dashboardHelp>) => c.sections.flatMap((s) => [s.title, ...s.paragraphs]).join("\\n");

describe("How it works content", () => {
  it("Dashboard: the store's lead time, order days and cost coverage; links to the settings behind them", () => {
    const c = dashboardHelp(tEn, "en", { leadTimeDays: 21, cycleDays: 30, costPercent: 87, supplierCount: 5 });
    expect(text(c)).toContain("An order arrives after the lead time (21 days unless a supplier has its own) and covers 30 days of sales after that");
    expect(text(c)).toContain("Cost prices are known for 87% of your products.");
    expect(c.links.map((l) => l.to)).toEqual(["/app/settings?more=1", "/app/settings/suppliers"]);
    // Every cost known: no cost sentence; no suppliers: "Add your suppliers".
    const all = dashboardHelp(tEn, "en", { leadTimeDays: 21, cycleDays: 30, costPercent: 100, supplierCount: 0 });
    expect(text(all)).not.toContain("Cost prices are known");
    expect(all.links[1]!.label).toBe("Add your suppliers");
  });
  it("Due now without a line to show: the rule only, no made-up example", () => {
    expect(text(dueNowHelp(tEn, "en", null))).not.toContain("Example from your store");
  });
  it("every panel is translated (German)", () => {
    for (const c of [dashboardHelp(tDe, "de", { leadTimeDays: 14, cycleDays: null, costPercent: null, supplierCount: 1 }), dueNowHelp(tDe, "de", null), calendarHelp(tDe), productsHelp(tDe), purchaseOrdersHelp(tDe)]) {
      for (const s of c.sections) {
        expect(s.title).not.toBe(translate("en", s.title) === s.title && tDe(s.title) === s.title ? "" : "x");
      }
    }
    expect(purchaseOrdersHelp(tDe).sections[0]!.title).toBe("So läuft eine Bestellung ab");
    expect(productsHelp(tDe).sections[0]!.paragraphs[0]).toBe("Nicht vorrätig: nichts mehr zu verkaufen.");
  });

  it("Product detail: this product's lead time and order days; the supplier's settings first when it has its own", () => {
    const c = productDetailHelp(tEn, "en", { leadTimeDays: 45, cycleDays: 120, fromSupplier: true });
    expect(text(c)).toContain("An order for this product takes 45 days to arrive and is sized to last 120 days after that, plus safety stock.");
    expect(c.links[0]!.to).toBe("/app/settings/suppliers");
    // Locked (Free) or not computed yet: no made-up numbers.
    const locked = productDetailHelp(tEn, "en", { leadTimeDays: null, cycleDays: null, fromSupplier: false });
    expect(text(locked)).not.toContain("takes");
    expect(locked.links[0]!.to).toBe("/app/settings?more=1");
  });

  it("every remaining page has a panel, translated, linking only to real pages", () => {
    const panels = [seasonHelp, buildOrderHelp, plansHelp, ...(["defaults", "suppliers", "locations", "alerts", "import"] as const).map((tab) => (t: typeof tEn) => settingsHelp(t, tab))];
    const routes = new Set(["/app/reorder", "/app/reorder/calendar", "/app/settings", "/app/settings?more=1", "/app/settings/suppliers"]);
    for (const p of panels) {
      const en = p(tEn);
      const de = p(tDe);
      expect(en.sections.length).toBeGreaterThan(0);
      for (const [i, s] of en.sections.entries()) {
        expect(s.paragraphs.length).toBeGreaterThan(0);
        expect(de.sections[i]!.title).not.toBe(s.title);
      }
      for (const l of en.links) expect(routes.has(l.to)).toBe(true);
    }
  });

  it("the button is on every main page", () => {
    for (const f of [
      "app._index", "app.reorder", "app.reorder_.calendar", "app.reorder_.orders", "app.reorder_.$id", "app.reorder_.build", "app.reorder_.season",
      "app.products", "app.products_.$variantId", "app.settings", "app.settings_.suppliers", "app.settings_.locations", "app.settings_.alerts", "app.settings_.import", "app.plans",
    ]) {
      expect(readFileSync(`app/routes/${f}.tsx`, "utf8"), f).toMatch(/help=\{/);
    }
  });
});
