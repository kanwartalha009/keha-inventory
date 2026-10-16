/**
 * Action list (task 2.3, spec §5.1, §7.7, §4 J4): links per kind, the Keha
 * Preorder deep link (id normalisation, the 50 cap, ship date rules), plan
 * limits (Free top 10, Fix as a count, locked Bridge / Clear), snooze /
 * dismiss resurfacing, clearances and the state changes.
 */
import { describe, expect, it } from "vitest";
import {
  BRIDGE_MAX_VARIANTS,
  adminProductUrl,
  arrivalOf,
  bridgeUrl,
  buildActionList,
  buttonFor,
  clip,
  isActionOp,
  needsPreorderCheck,
  numericId,
  parseTab,
  readReason,
  reorderHref,
  stateChange,
  variantDetailHref,
  variantGidOf,
  type ActionRowIn,
  type ClearanceRowIn,
  type VariantInfo,
} from "../app/lib/action-list-shared";
import type { PlanCode } from "../app/lib/plan-shared";

const NOW = new Date("2026-10-19T08:00:00Z");
const TODAY = "2026-10-19";
const P = (n: number) => `gid://shopify/Product/${n}`;
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;

function action(over: Partial<ActionRowIn> & { id: string }): ActionRowIn {
  return {
    kind: "reorder",
    productId: P(1),
    variantIds: [V(11)],
    amount: 100,
    currency: "EUR",
    reason: { key: "reorder_running_low", params: { days: 9 }, facts: { rate: 2.5, leadTimeDays: 14 } },
    state: "open",
    snoozeUntil: null,
    stateAmount: null,
    ...over,
  };
}

const VARIANTS: VariantInfo[] = [
  { id: V(11), productId: P(1), productTitle: "Linen shirt", variantTitle: "S / Blue", image: "https://cdn/x.jpg" },
  { id: V(12), productId: P(1), productTitle: "Linen shirt", variantTitle: "M / Blue", image: null },
  { id: V(21), productId: P(2), productTitle: "Wool scarf", variantTitle: "Default Title", image: null },
];

function build(actions: ActionRowIn[], plan: PlanCode, extra: Partial<Parameters<typeof buildActionList>[0]> = {}) {
  return buildActionList({
    actions,
    variants: VARIANTS,
    clearances: [],
    plan,
    now: NOW,
    today: TODAY,
    storeHandle: "acme",
    preorderInstalled: false,
    currency: "EUR",
    ...extra,
  });
}

describe("tabs and ids", () => {
  it("parses ?tab= and falls back to All", () => {
    expect(parseTab("clear")).toBe("clear");
    expect(parseTab(" Fix ")).toBe("fix");
    expect(parseTab("fix_sizes")).toBe("all");
    expect(parseTab(null)).toBe("all");
  });

  it("normalises numeric ids and gids", () => {
    expect(numericId("gid://shopify/ProductVariant/123")).toBe("123");
    expect(numericId("456")).toBe("456");
    expect(numericId("gid://shopify/ProductVariant/abc")).toBeNull();
    expect(numericId("")).toBeNull();
    expect(variantGidOf("789")).toBe(V(789));
    expect(variantGidOf(V(1))).toBe(V(1));
    expect(variantGidOf("gid://shopify/Product/1")).toBeNull();
  });

  it("clips by code point after collapsing spaces", () => {
    expect(clip("  a   b  ", 10)).toBe("a b");
    expect(clip("x".repeat(130), 120)).toHaveLength(120);
    expect(Array.from(clip("😀".repeat(5), 3))).toHaveLength(3);
  });
});

describe("Keha Preorder link (spec §4 J4)", () => {
  const base = { storeHandle: "acme", today: TODAY, name: "Linen shirt", arrival: "2026-11-02" };

  it("pre-fills variants (numeric), trigger=stock, ship and name", () => {
    const url = bridgeUrl({ ...base, variantIds: [V(11), "12", V(11)] })!;
    expect(url.startsWith("https://admin.shopify.com/store/acme/apps/keha-preorder/app/campaigns/new?")).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get("variants")).toBe("11,12");
    expect(q.get("trigger")).toBe("stock");
    expect(q.get("ship")).toBe("2026-11-02");
    expect(q.get("name")).toBe("Linen shirt");
  });

  it("caps at 50 variants and drops unusable ids", () => {
    const ids = ["junk", ...Array.from({ length: 70 }, (_, i) => V(i + 1))];
    const q = new URL(bridgeUrl({ ...base, variantIds: ids })!).searchParams;
    const list = q.get("variants")!.split(",");
    expect(list).toHaveLength(BRIDGE_MAX_VARIANTS);
    expect(list[0]).toBe("1");
    expect(list.at(-1)).toBe("50");
  });

  it("leaves out an unknown, invalid or past ship date", () => {
    for (const arrival of [null, "2026-02-30", "soon", "2026-10-18"]) {
      const q = new URL(bridgeUrl({ ...base, arrival, variantIds: [V(1)] })!).searchParams;
      expect(q.has("ship")).toBe(false);
    }
    const today = new URL(bridgeUrl({ ...base, arrival: TODAY, variantIds: [V(1)] })!).searchParams;
    expect(today.get("ship")).toBe(TODAY);
  });

  it("cuts the name to 120 characters and encodes it", () => {
    const q = new URL(bridgeUrl({ ...base, name: `Shirt & "co" ${"x".repeat(200)}`, variantIds: [V(1)] })!).searchParams;
    expect(q.get("name")).toHaveLength(120);
    expect(q.get("name")!.startsWith('Shirt & "co"')).toBe(true);
  });

  it("is null without a usable variant or store", () => {
    expect(bridgeUrl({ ...base, variantIds: [] })).toBeNull();
    expect(bridgeUrl({ ...base, variantIds: ["nope"] })).toBeNull();
    expect(bridgeUrl({ ...base, storeHandle: " ", variantIds: [V(1)] })).toBeNull();
  });

  it("reads the arrival day from reason facts or params", () => {
    expect(arrivalOf({ facts: { arrivalDate: "2026-11-02" } })).toBe("2026-11-02");
    expect(arrivalOf({ params: { arrivalDate: "2026-11-03" } })).toBe("2026-11-03");
    expect(arrivalOf({ facts: { arrivalDate: "Nov 2" } })).toBeNull();
    expect(arrivalOf(null)).toBeNull();
  });
});

describe("links", () => {
  it("reorder plan, product detail and Shopify admin", () => {
    expect(reorderHref([V(1), "2", "bad"])).toBe(
      `/app/reorder?variants=${encodeURIComponent(`${V(1)},${V(2)}`)}`,
    );
    expect(new URLSearchParams(reorderHref([V(1), V(2)]).split("?")[1]).get("variants")).toBe(`${V(1)},${V(2)}`);
    expect(reorderHref([])).toBe("/app/reorder");
    expect(variantDetailHref(V(42))).toBe("/app/products/42");
    expect(variantDetailHref(undefined)).toBe("/app/products");
    expect(adminProductUrl(P(7))).toBe("shopify://admin/products/7");
  });
});

describe("buttons by kind (spec §7.7)", () => {
  const ctx = { plan: "growth" as PlanCode, preorderInstalled: false, storeHandle: "acme", today: TODAY, productTitle: "Linen shirt" };
  const btn = (kind: string, over: Partial<typeof ctx> = {}, reason: unknown = {}) =>
    buttonFor({ kind, productId: P(1), variantIds: [V(11), V(12)], reason }, { ...ctx, ...over });

  it("maps every kind", () => {
    expect(btn("reorder")).toEqual({ kind: "reorder", href: reorderHref([V(11), V(12)]) });
    expect(btn("push")).toEqual({ kind: "pushHow", productUrl: "shopify://admin/products/1" });
    expect(btn("fix_falling")).toEqual({ kind: "seeWhy", href: "/app/products/11" });
    expect(btn("fix_sizes")).toEqual({ kind: "restockSizes", href: reorderHref([V(11), V(12)]) });
    expect(btn("fix_page")).toEqual({ kind: "checkPage", productUrl: "shopify://admin/products/1" });
    expect(btn("fix_returns")).toEqual({ kind: "checkSizing", productUrl: "shopify://admin/products/1" });
    expect(btn("clear")).toEqual({ kind: "createDiscount" });
  });

  it("bridge: preorder link only when Keha Preorder is installed, else the sign-ups how-to", () => {
    const reason = { facts: { arrivalDate: "2026-11-02" } };
    const installed = btn("bridge", { preorderInstalled: true }, reason);
    expect(installed.kind).toBe("preorder");
    expect(installed.kind === "preorder" && installed.href).toContain("keha-preorder");
    const not = btn("bridge", {}, reason);
    expect(not).toEqual({ kind: "signups", productUrl: "shopify://admin/products/1", arrival: "2026-11-02" });
    expect(JSON.stringify(not)).not.toContain("keha-preorder");
  });

  it("Free: Bridge and Clear are locked, never linked", () => {
    expect(btn("bridge", { plan: "free", preorderInstalled: true })).toEqual({ kind: "locked", feature: "bridge" });
    expect(btn("clear", { plan: "free" })).toEqual({ kind: "locked", feature: "clearance" });
    expect(btn("reorder", { plan: "free" }).kind).toBe("reorder");
  });

  it("asks about Keha Preorder only for a paid plan with a visible Bridge row", () => {
    const bridge = action({ id: "b", kind: "bridge" });
    expect(needsPreorderCheck([bridge], "growth", NOW)).toBe(true);
    expect(needsPreorderCheck([bridge], "free", NOW)).toBe(false);
    expect(needsPreorderCheck([action({ id: "r" })], "pro", NOW)).toBe(false);
    expect(needsPreorderCheck([{ ...bridge, state: "dismissed", stateAmount: 100 }], "pro", NOW)).toBe(false);
  });
});

describe("reason", () => {
  it("keeps scalar params and facts only", () => {
    const r = readReason({ key: "k", params: { n: 3, s: "x", bad: { a: 1 }, nan: NaN }, facts: { rate: 1.5, none: null, obj: [] } });
    expect(r).toEqual({ key: "k", params: { n: 3, s: "x" }, facts: [{ label: "rate", value: 1.5 }, { label: "none", value: null }] });
    expect(readReason("junk")).toEqual({ key: "", params: {}, facts: [] });
  });
});

describe("buildActionList", () => {
  const many = [
    ...Array.from({ length: 12 }, (_, i) => action({ id: `r${i}`, amount: 1000 - i, productId: P(1) })),
    action({ id: "f1", kind: "fix_sizes", amount: 5000 }),
    action({ id: "f2", kind: "fix_page", amount: 1 }),
    action({ id: "c1", kind: "clear", amount: 2000, productId: P(2), variantIds: [V(21)] }),
    action({ id: "b1", kind: "bridge", amount: 1500 }),
  ];

  it("Free: top 10 non-Fix rows, Fix as a count, the rest counted, nothing locked hidden", () => {
    const list = build(many, "free");
    expect(list.rows.map((r) => r.id)).toEqual(["c1", "b1", "r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    expect(list.rows.some((r) => r.tab === "fix")).toBe(false);
    expect(list.fixCount).toBe(2);
    expect(list.counts.fix).toBe(2);
    expect(list.hiddenCount).toBe(4);
    expect(list.counts.all).toBe(10);
    expect(list.rows.find((r) => r.id === "c1")!.button).toEqual({ kind: "locked", feature: "clearance" });
    expect(list.rows.find((r) => r.id === "b1")!.button).toEqual({ kind: "locked", feature: "bridge" });
  });

  it("Growth: every row, ranked by € across groups", () => {
    const list = build(many, "growth");
    expect(list.rows).toHaveLength(16);
    expect(list.rows[0]!.id).toBe("f1");
    expect(list.fixCount).toBe(0);
    expect(list.hiddenCount).toBe(0);
    expect(list.counts).toEqual({ all: 16, reorder: 12, bridge: 1, push: 0, fix: 2, clear: 1 });
  });

  it("joins product title, image and variant names (no 'Default Title'), +N more", () => {
    const vs: VariantInfo[] = [
      ...VARIANTS,
      ...[13, 14, 15].map((n) => ({ id: V(n), productId: P(1), productTitle: "Linen shirt", variantTitle: `V${n}`, image: null })),
    ];
    const list = build([action({ id: "a", variantIds: [V(12), V(11), V(13), V(14), V(15)] }), action({ id: "s", productId: P(2), variantIds: [V(21)], amount: 1 })], "growth", { variants: vs });
    const a = list.rows[0]!;
    expect(a.productTitle).toBe("Linen shirt");
    expect(a.image).toBe("https://cdn/x.jpg");
    expect(a.variants).toEqual(["M / Blue", "S / Blue", "V13"]);
    expect(a.moreVariants).toBe(2);
    expect(list.rows[1]!.variants).toEqual([]);
    const gone = build([action({ id: "g", productId: P(99), variantIds: [V(99)] })], "growth").rows[0]!;
    expect(gone.productTitle).toBeNull();
  });

  it("hides snoozed / dismissed / done rows until the snooze ends or the € figure doubles; drops unknown kinds", () => {
    const rows = [
      action({ id: "snoozed", state: "snoozed", snoozeUntil: new Date("2026-10-20T00:00:00Z"), stateAmount: 100 }),
      action({ id: "back", state: "snoozed", snoozeUntil: new Date("2026-10-18T00:00:00Z"), stateAmount: 100 }),
      action({ id: "doubled", state: "dismissed", amount: 200, stateAmount: 100 }),
      action({ id: "dismissed", state: "dismissed", amount: 150, stateAmount: 100 }),
      action({ id: "done", state: "done" }),
      action({ id: "weird", kind: "transfer" }),
    ];
    expect(build(rows, "growth").rows.map((r) => r.id).sort()).toEqual(["back", "doubled"]);
  });

  it("empty input → empty list", () => {
    const list = build([], "free");
    expect(list.rows).toEqual([]);
    expect(list.fixCount).toBe(0);
    expect(list.hiddenCount).toBe(0);
  });

  it("clearances: running only, cash freed never negative, '—' when unknown", () => {
    const c = (over: Partial<ClearanceRowIn>): ClearanceRowIn => ({
      id: "c",
      kind: "automatic",
      code: null,
      percent: 20,
      productIds: [P(2)],
      startsAt: new Date("2026-10-01T00:00:00Z"),
      endsAt: null,
      baselineCash: 1000,
      currency: "EUR",
      currentCash: 600,
      retail: false,
      productTitle: "Wool scarf",
      ...over,
    });
    const list = build([], "growth", {
      clearances: [
        c({ id: "a" }),
        c({ id: "ended", endsAt: new Date("2026-10-18T21:59:59Z") }),
        c({ id: "today", endsAt: new Date("2026-10-19T21:59:59Z"), kind: "code", code: "CLEAR-7Q3K" }),
        c({ id: "up", currentCash: 1300 }),
        c({ id: "unknown", currentCash: null }),
        c({ id: "nobase", baselineCash: 0 }),
      ],
    });
    expect(list.clearances.map((x) => [x.id, x.cashFreed])).toEqual([
      ["a", 400],
      ["today", 400],
      ["up", 0],
      ["unknown", null],
      ["nobase", null],
    ]);
    expect(list.clearances[1]).toMatchObject({ kind: "code", code: "CLEAR-7Q3K", endsOn: "2026-10-19" });
  });
});

describe("state changes", () => {
  it("snooze 7 days and dismiss remember the € figure; done stamps; undo reopens", () => {
    expect(stateChange("snooze", 120, NOW)).toEqual({
      state: "snoozed",
      snoozeUntil: new Date("2026-10-26T08:00:00Z"),
      stateAmount: 120,
      doneAt: null,
    });
    expect(stateChange("dismiss", 120, NOW)).toEqual({ state: "dismissed", snoozeUntil: null, stateAmount: 120, doneAt: null });
    expect(stateChange("done", 120, NOW)).toEqual({ state: "done", snoozeUntil: null, stateAmount: null, doneAt: NOW });
    expect(stateChange("undo", 120, NOW)).toEqual({ state: "open", snoozeUntil: null, stateAmount: null, doneAt: null });
    expect(isActionOp("snooze")).toBe(true);
    expect(isActionOp("clear")).toBe(false);
  });
});
