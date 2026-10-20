import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub, Outlet } from "react-router";
import { buildBriefing, MAX_SENTENCES, type BriefingInput } from "../app/lib/briefing-shared";
import { BriefingCard } from "../app/components/briefing";
import { LocaleProvider, translate, type Locale } from "../app/lib/i18n";

// Kanwar 2026-10-18: "what's going on and what to do — orders, preorder, discounting — in 30
// seconds", and Clearance reachable from the Dashboard instead of hidden in a tab.

const sup = (key: string, overdue: boolean, cash: number) => ({ supplierKey: key, products: 2, orderByFrom: "2026-10-18", orderByTo: "2026-10-20", overdue, late: overdue, events: [], units: 10, cash, missingCost: 0, lines: 2 });
const input = (over: Partial<BriefingInput> = {}): BriefingInput => ({
  currency: "EUR",
  week: { suppliers: [sup("supplier:a", true, 600), sup("supplier:b", false, 400)], totals: { units: 20, cash: 1000, missingCost: 0, lines: 4 }, next: null },
  counts: { all: 20, reorder: 8, bridge: 2, push: 4, fix: 3, clear: 6 },
  cashStuck: 3693,
  ...over,
});

describe("buildBriefing", () => {
  it("order first, then sold out, dead stock, pages — at most 3 sentences; 4 tiles always", () => {
    const b = buildBriefing(input())!;
    expect(b.sentences.map((s) => s.key)).toEqual(["order", "soldOut", "clear"]);
    expect(b.sentences.length).toBeLessThanOrEqual(MAX_SENTENCES);
    expect(b.sentences[0]).toEqual({ key: "order", suppliers: 2, cash: 1000, late: 1 });
    expect(b.tiles.map((t) => [t.key, t.count, t.amount, t.href])).toEqual([
      ["order", 2, 1000, "/app/reorder"],
      ["soldOut", 2, null, "/app/actions?tab=bridge"],
      ["clear", 6, 3693, "/app/actions?tab=clear"],
      ["fix", 3, null, "/app/actions?tab=fix"],
    ]);
  });
  it("nothing to order: says when the next order is; nothing else to say: one sentence", () => {
    const b = buildBriefing(input({ week: { suppliers: [], totals: { units: 0, cash: null, missingCost: 0, lines: 0 }, next: { supplierKey: "supplier:a", orderBy: "2026-11-02" } }, counts: { all: 0 } }))!;
    expect(b.sentences).toEqual([{ key: "nothingToOrder", nextOrderBy: "2026-11-02" }]);
    expect(b.tiles.every((t) => t.count === 0)).toBe(true);
  });
  it("cash tied up only when there is something to clear; no plan yet: no report", () => {
    expect(buildBriefing(input({ counts: { all: 1, clear: 0 } }))!.tiles.find((t) => t.key === "clear")!.amount).toBeNull();
    expect(buildBriefing(input({ week: null }))).toBeNull();
  });
});

function render(locale: Locale, briefing = buildBriefing(input())!) {
  const Shell = () => (
    <LocaleProvider defaultLocale={locale}>
      <Outlet />
    </LocaleProvider>
  );
  const Screen = () => <BriefingCard briefing={briefing} />;
  const Stub = createRoutesStub([{ id: "shell", path: "/", Component: Shell, children: [{ id: "screen", path: "/app", Component: Screen }] }]);
  return renderToString(<Stub initialEntries={["/app"]} />);
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

describe("BriefingCard", () => {
  for (const locale of ["en", "de"] as const) {
    it(`${locale}: plain sentences and one button per job`, () => {
      const html = render(locale);
      expect(html).toContain(esc(translate(locale, "This week")));
      expect(html).toContain(esc(translate(locale, "1 order is already late.")));
      expect(html).toContain(esc(translate(locale, "Create discounts")));
      expect(html).toContain('href="/app/actions?tab=clear"');
      expect(html).toContain('href="/app/reorder"');
    });
  }
  it("English wording", () => {
    const html = render("en");
    expect(html).toContain("Order from 2 suppliers this week (€1,000). 1 order is already late.");
    expect(html).toContain("2 products are sold out while shoppers still look for them: reorder them or take preorders.");
    expect(html).toContain("6 products aren&#x27;t selling and tie up €3,693. A discount turns that back into cash.");
  });
  it("audit 2026-10-18: below safety stock isn't late; no cost prices doesn't read as nothing due", () => {
    const belowSafety = { ...sup("supplier:a", true, 600), late: false };
    const b = buildBriefing(input({ week: { suppliers: [belowSafety], totals: { units: 10, cash: null, missingCost: 2, lines: 2 }, next: null } }))!;
    expect(b.sentences[0]).toMatchObject({ key: "order", suppliers: 1, late: 0 });
    const html = render("en", b);
    expect(html).not.toContain("already late");
    expect(html).not.toContain("Nothing due this week");
    expect(html).toContain("Due this week");
  });
});
