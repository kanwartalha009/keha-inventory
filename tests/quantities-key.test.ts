/**
 * Review fix: typed quantities on Reorder and transfer cards survive another form's submit.
 * The cards reset only when quantitiesKey changes; a loader revalidation hands them a new
 * group object with the same content, which must give the same key.
 */
import { describe, expect, it } from "vitest";
import { quantitiesKey } from "../app/lib/quantities-key-shared";

const group = () => ({
  key: "supplier:s1",
  lines: [
    { variantId: "gid://shopify/ProductVariant/2", suggested: 12 },
    { variantId: "gid://shopify/ProductVariant/1", suggested: 4 },
  ],
});
const keyOf = (g: ReturnType<typeof group>) => quantitiesKey(g.key, g.lines.map((l) => [l.variantId, l.suggested] as const));

describe("quantitiesKey", () => {
  it("is the same for a new object with the same content (revalidation after another submit)", () => {
    const a = group();
    const b = group();
    expect(a).not.toBe(b);
    expect(keyOf(a)).toBe(keyOf(b));
    // Line order from the server does not matter.
    expect(keyOf({ ...b, lines: [...b.lines].reverse() })).toBe(keyOf(a));
  });

  it("changes when a suggested quantity, a line or the group changes", () => {
    const a = group();
    expect(keyOf({ ...a, lines: [{ ...a.lines[0], suggested: 13 }, a.lines[1]] })).not.toBe(keyOf(a));
    expect(keyOf({ ...a, lines: a.lines.slice(1) })).not.toBe(keyOf(a));
    expect(keyOf({ ...a, key: "supplier:s2" })).not.toBe(keyOf(a));
  });

  it("ids with separators cannot collide", () => {
    expect(quantitiesKey("g", [["a,1", 2]])).not.toBe(quantitiesKey("g", [["a", 1], ["2", 2]]));
    expect(quantitiesKey("g", [["a", null]])).not.toBe(quantitiesKey("g", [["a", 0]]));
  });
});

describe("the cards key their reset on content, not on the group object", () => {
  it("Reorder and transfer cards use quantitiesKey for the reset", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const f of ["app/routes/app.reorder.tsx", "app/components/transfers-section.tsx"]) {
      const src = readFileSync(join(__dirname, "..", f), "utf8");
      expect(src, f).toMatch(/const resetKey = quantitiesKey\(/);
      expect(src, f).toMatch(/useMemo\([^;]*\[resetKey\]\)/);
      expect(src, f).not.toMatch(/useMemo\([^;]*\[group\]\)/);
    }
  });
});
