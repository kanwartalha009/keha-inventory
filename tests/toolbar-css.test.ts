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
  it("two rows: the search on its own row, the filters as one shared row below it", () => {
    const bar = rule(".keha-toolbar");
    expect(bar.display).toBe("flex");
    expect(bar["flex-direction"]).toBe("column");
    expect(rule(".keha-toolbar__search").width).toBe("100%");
    const group = rule(".keha-toolbar__filters");
    expect(group["flex-wrap"]).toBe("wrap");
    expect(group.width).toBe("100%");
    const item = rule(".keha-toolbar__filters > .keha-toolbar__item");
    expect(item.flex).toBe("1 1 180px");
    expect(item["min-width"]).toBe("160px");
  });

  it("three filters fit one row at the admin's widths (with or without the Sidekick panel)", () => {
    const min = px(rule(".keha-toolbar__filters > .keha-toolbar__item")["min-width"]);
    const fits = (width: number, n: number) => n * min + (n - 1) * GAP <= width;
    expect(fits(880 - 32, 3)).toBe(true); // full admin width
    expect(fits(560 - 32, 3)).toBe(true); // Sidekick panel open
    expect(fits(880 - 32, 4)).toBe(true); // + location select on Pro
  });

  it("DESIGN-RULES says the same", () => {
    const rules = readFileSync(join(__dirname, "../docs/DESIGN-RULES.md"), "utf8");
    expect(rules).toContain("**as one horizontal row** below it");
    expect(rules).toContain("Never let the filters stack into a column beside the search");
  });
});
