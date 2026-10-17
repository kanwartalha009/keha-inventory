/**
 * Review sweep (UI and i18n): visible numbers that escaped the coverage test are formatted
 * in the admin / store language — percent badges and labels, alert visit counts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alertLine, type InstantAlert } from "../app/lib/alerts-shared";

const UI_DIRS = ["app/routes", "app/components"];

describe("i18n sweep", () => {
  it("no hand-built percent ('{x}%') in a screen: percents go through Intl (fr '20 %', de '20 %')", () => {
    const offenders: string[] = [];
    for (const dir of UI_DIRS) {
      for (const name of readdirSync(join(__dirname, "..", dir))) {
        if (!name.endsWith(".tsx")) continue;
        const src = readFileSync(join(__dirname, "..", dir, name), "utf8");
        src.split("\n").forEach((line, i) => {
          // `${x}%` in a template literal, or {x}% as JSX text. t("… {pct}% …") templates are fine.
          const code = line.replace(/\b(?:t|tr)\("(?:[^"\\]|\\.)*"\)/g, '""');
          if (/\$\{[^}]+\}%|[^"{]\{[^{}"]+\}%/.test(code)) offenders.push(`${dir}/${name}:${i + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("alert visit counts use the store's number format", () => {
    const sell: InstantAlert = { kind: "sell_out", productId: "p", variantId: "v", title: "Cap", sessions: 1234 };
    expect(alertLine("de", sell, "https://x", "de").detail).toContain("1.234");
    expect(alertLine("en", sell, "https://x").detail).toBe("Visits to this product last week: 1,234.");
  });
});

describe("screen names (nav: Order plan; tabs: Order now, Next 13 weeks, Season plan, Open orders)", () => {
  it("no English key names a 'Reorder' screen or page any more", async () => {
    const { AREAS } = await import("../app/lib/i18n");
    const keys = Object.values(AREAS).flatMap((a) => Object.keys(a));
    // "Reorder" stays as the action (the Reorder tab of the action list, "Reorder again").
    // Capitalised = the screen ("on Reorder"); lower case "what to reorder" is the verb.
    const screen = /\b(on|in|to|open|from|see|and) (the )?Reorder\b|\bReorder (page|screen)\b/;
    expect(keys.filter((k) => screen.test(k))).toEqual([]);
  });
});
