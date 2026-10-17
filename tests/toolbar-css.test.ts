/**
 * The shared toolbar (ui.tsx <Toolbar>, app.css .keha-toolbar; DESIGN-RULES 8). Click-through
 * 2026-10-17: at the admin's ~880px the Products filters (All statuses, All vendors, Sort) stacked
 * into a column beside the search, because the filter group could shrink and then wrapped inside.
 * The group must never shrink: one row with the search, or one row of its own below it.
 * jsdom has no layout, so this holds the CSS contract and checks the widths it implies.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "../app/app.css"), "utf8");

/** Declarations of the first top-level rule with exactly this selector (outside @media). */
function rule(selector: string): Record<string, string> {
  const top = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const esc = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
  const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m").exec(top);
  expect(m, selector).not.toBeNull();
  const out: Record<string, string> = {};
  for (const d of m![1]!.split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return out;
}

const px = (v: string) => Number(/(\d+)px/.exec(v)?.[1] ?? NaN);
const GAP = 8; // --keha-space-200

describe(".keha-toolbar", () => {
  it("the filter group never shrinks and keeps its controls in one row", () => {
    const bar = rule(".keha-toolbar");
    expect(bar["flex-wrap"]).toBe("wrap");
    expect(bar["align-items"]).toBe("center");
    const group = rule(".keha-toolbar__filters");
    expect(group.flex).toBe("none");
    expect(group["max-width"]).toBe("100%");
    expect(group["margin-inline-start"]).toBe("auto");
    const item = rule(".keha-toolbar__filters > *");
    expect(item.flex).toBe("0 0 180px");
    const search = rule(".keha-toolbar__search");
    expect(search.flex).toBe("1 1 240px");
  });

  it("at the admin's content widths: one row at ~880px; at 600px the filters take their own single row", () => {
    const search = px(rule(".keha-toolbar__search").flex);
    const select = px(rule(".keha-toolbar__filters > *").flex);
    // Products: status, vendor, sort (the location select only on Pro with two locations).
    const group = 3 * select + 2 * GAP;
    const layout = (width: number) => (width >= search + GAP + group ? "one row" : width >= group ? "filters below, one row" : "filters wrap");
    // ~880px content minus the table card's padding.
    expect(layout(880 - 32)).toBe("one row");
    expect(layout(640)).toBe("filters below, one row");
    expect(layout(500)).toBe("filters wrap");
  });

  it("DESIGN-RULES says the same", () => {
    const rules = readFileSync(join(__dirname, "../docs/DESIGN-RULES.md"), "utf8");
    expect(rules).toContain("**as one horizontal row** below the search");
    expect(rules).toContain("Never let the filters stack into a column beside the search");
  });
});
