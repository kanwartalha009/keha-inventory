/** Action list contract (spec §5.1, §7.7): tabs, ranking, snooze/dismiss resurfacing. */
import { describe, expect, it } from "vitest";
import { dedupeKey, isVisible, rankActions, rowsForTab, tabOf } from "../app/lib/actions-shared";

const now = new Date("2026-10-19T08:00:00Z");

describe("actions contract", () => {
  it("maps fix kinds to the Fix tab", () => {
    expect(tabOf("fix_sizes")).toBe("fix");
    expect(tabOf("fix_returns")).toBe("fix");
    expect(tabOf("reorder")).toBe("reorder");
    expect(tabOf("clear")).toBe("clear");
  });

  it("dedupes one row per kind and product", () => {
    expect(dedupeKey("reorder", "gid://shopify/Product/1")).toBe("reorder:gid://shopify/Product/1");
  });

  it("ranks by € desc, then kind order, then product id", () => {
    const rows = [
      { kind: "clear" as const, amount: 100, productId: "b" },
      { kind: "reorder" as const, amount: 100, productId: "c" },
      { kind: "reorder" as const, amount: 100, productId: "a" },
      { kind: "push" as const, amount: 500, productId: "z" },
    ];
    expect(rankActions(rows).map((r) => `${r.kind}:${r.productId}`)).toEqual(["push:z", "reorder:a", "reorder:c", "clear:b"]);
    expect(rowsForTab(rows, "reorder").map((r) => r.productId)).toEqual(["a", "c"]);
  });

  it("keeps snoozed rows hidden until the date passes or the € figure doubles", () => {
    const base = { state: "snoozed" as const, stateAmount: 100, snoozeUntil: new Date("2026-10-25T00:00:00Z") };
    expect(isVisible({ ...base, amount: 150 }, now)).toBe(false);
    expect(isVisible({ ...base, amount: 200 }, now)).toBe(true);
    expect(isVisible({ ...base, amount: 150 }, new Date("2026-10-26T00:00:00Z"))).toBe(true);
  });

  it("keeps dismissed rows hidden unless the € figure doubles; done rows never return", () => {
    expect(isVisible({ state: "dismissed", amount: 199, stateAmount: 100, snoozeUntil: null }, now)).toBe(false);
    expect(isVisible({ state: "dismissed", amount: 200, stateAmount: 100, snoozeUntil: null }, now)).toBe(true);
    expect(isVisible({ state: "done", amount: 10_000, stateAmount: 1, snoozeUntil: null }, now)).toBe(false);
    expect(isVisible({ state: "open", amount: 0, stateAmount: null, snoozeUntil: null }, now)).toBe(true);
  });
});
