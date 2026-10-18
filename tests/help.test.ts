import { describe, expect, it } from "vitest";
import { calendarHelp, dashboardHelp, dueNowHelp, productsHelp, purchaseOrdersHelp } from "../app/components/help";
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
    expect(c.links.map((l) => l.to)).toEqual(["/app/settings", "/app/settings/suppliers"]);
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
});
